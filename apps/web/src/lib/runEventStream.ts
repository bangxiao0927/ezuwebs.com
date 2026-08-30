import { createSseParser } from "./sse.js";
import { reconnectDelayMs } from "./reconnectBackoff.js";
import type { RunAgentEventDto, RunEventDto, RunStatus } from "../types";

const RUN_TERMINAL_STATUSES = new Set<RunStatus>(["completed", "failed", "cancelled"]);

export interface RunEventStreamHandlers {
  onEvent: (entry: RunEventDto) => void;
  onStatus: (status: RunStatus) => void;
  /** Called before the backoff sleep, once per reconnect attempt. */
  onReconnecting?: (attempt: number) => void;
  /** Called when the stream itself reports a mid-flight `event: error` frame. */
  onStreamError?: (message: string) => void;
}

export interface RunEventStreamDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Base path for the JSON API, e.g. "/api". Defaults to "/api". */
  apiBase?: string;
}

export interface RunEventStreamHandle {
  /** Aborts the local connection only; never calls the cancel-run endpoint. */
  close(): void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Streams a run's SSE events from `afterSeq=-1` (from the start), resuming
 * from the last seen seq after any disconnect that is not the run's own
 * terminal status. The caller decides what a disconnect vs. a terminal
 * status means for the UI; this module only tells them apart.
 */
export function openRunEventStream(
  sessionId: string,
  runId: string,
  handlers: RunEventStreamHandlers,
  deps: RunEventStreamDeps = {},
): RunEventStreamHandle {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepImpl = deps.sleepImpl ?? defaultSleep;
  const apiBase = deps.apiBase ?? "/api";

  let cursor = -1;
  let closed = false;
  let activeController: AbortController | undefined;

  const eventsUrl = (): string =>
    `${apiBase}/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/events?afterSeq=${cursor}`;
  const runUrl = (): string =>
    `${apiBase}/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`;

  async function connectOnce(): Promise<void> {
    activeController = new AbortController();
    const response = await fetchImpl(eventsUrl(), {
      credentials: "same-origin",
      signal: activeController.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Run stream request failed with status ${response.status}`);
    }

    const parser = createSseParser();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      const text = decoder.decode(value, { stream: true });
      for (const frame of parser.feed(text)) {
        if (frame.event === "error") {
          try {
            const payload = JSON.parse(frame.data) as { error: string };
            handlers.onStreamError?.(payload.error);
          } catch {
            // A malformed error frame is still just a signal to keep polling.
          }
          continue;
        }
        if (frame.event !== "agent" || frame.id === undefined) continue;
        const seq = Number(frame.id);
        if (!Number.isInteger(seq) || seq <= cursor) continue;
        cursor = seq;
        handlers.onEvent({ seq, event: JSON.parse(frame.data) as RunAgentEventDto });
      }
    }
  }

  async function fetchRunStatus(): Promise<RunStatus> {
    const response = await fetchImpl(runUrl(), { credentials: "same-origin" });
    const body = (await response.json()) as { run: { status: RunStatus } };
    return body.run.status;
  }

  async function loop(): Promise<void> {
    let attempt = 0;
    while (!closed) {
      try {
        await connectOnce();
      } catch {
        // A network failure and a clean end-of-stream are handled the same
        // way below: check whether the run itself is actually finished.
      }
      if (closed) return;

      const status = await fetchRunStatus().catch((): RunStatus => "running");
      if (closed) return;
      handlers.onStatus(status);
      if (RUN_TERMINAL_STATUSES.has(status)) return;

      attempt += 1;
      handlers.onReconnecting?.(attempt);
      await sleepImpl(reconnectDelayMs(attempt));
    }
  }

  void loop();

  return {
    close() {
      closed = true;
      activeController?.abort();
    },
  };
}
