import { createSseParser } from "./sse.js";
import { reconnectDelayMs } from "./reconnectBackoff.js";
import type { RunAgentEventDto, RunEventDto, RunStatus } from "../types";

const RUN_TERMINAL_STATUSES = new Set<RunStatus>(["completed", "failed", "cancelled"]);

// Statuses meaning the run itself is gone or the caller can never see it
// again; retrying can only ever repeat the same outcome.
const PERMANENT_HTTP_STATUSES = new Set([401, 403, 404]);

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;

class RunStatusFetchError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

export interface RunEventStreamHandlers {
  onEvent: (entry: RunEventDto) => void;
  onStatus: (status: RunStatus) => void;
  /** Called before the backoff sleep, once per reconnect attempt. */
  onReconnecting?: (attempt: number) => void;
  /** Called when the stream itself reports a mid-flight `event: error` frame. */
  onStreamError?: (message: string) => void;
  /**
   * Called once, in place of any further onStatus/onReconnecting calls, when
   * the stream gives up for good: a permanent status-fetch failure
   * (401/403/404) or a transient one (5xx/network) that exhausted
   * maxReconnectAttempts.
   */
  onError?: (error: Error) => void;
}

export interface RunEventStreamDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Base path for the JSON API, e.g. "/api". Defaults to "/api". */
  apiBase?: string;
  /** Consecutive transient status-fetch failures tolerated before giving up. */
  maxReconnectAttempts?: number;
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
  const maxReconnectAttempts = deps.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;

  let cursor = -1;
  let closed = false;
  let activeController: AbortController | undefined;

  const eventsUrl = (): string =>
    `${apiBase}/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/events?afterSeq=${cursor}`;
  const runUrl = (): string =>
    `${apiBase}/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`;

  /** Returns whether at least one new agent frame was delivered. */
  async function connectOnce(): Promise<boolean> {
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
    let receivedFrame = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) return receivedFrame;
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
        receivedFrame = true;
        handlers.onEvent({ seq, event: JSON.parse(frame.data) as RunAgentEventDto });
      }
    }
  }

  async function fetchRunStatus(): Promise<RunStatus> {
    const response = await fetchImpl(runUrl(), { credentials: "same-origin" });
    if (!response.ok) {
      throw new RunStatusFetchError(`Run status request failed with status ${response.status}`, response.status);
    }
    const body = (await response.json()) as { run: { status: RunStatus } };
    return body.run.status;
  }

  async function loop(): Promise<void> {
    let reconnectAttempt = 0;
    let statusFailures = 0;
    while (!closed) {
      let receivedFrame = false;
      try {
        receivedFrame = await connectOnce();
      } catch {
        // A network failure and a clean end-of-stream are handled the same
        // way below: check whether the run itself is actually finished.
      }
      if (closed) return;

      let status: RunStatus;
      try {
        status = await fetchRunStatus();
      } catch (error) {
        if (error instanceof RunStatusFetchError && PERMANENT_HTTP_STATUSES.has(error.httpStatus)) {
          handlers.onError?.(error);
          return;
        }
        statusFailures += 1;
        if (statusFailures > maxReconnectAttempts) {
          handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        reconnectAttempt += 1;
        handlers.onReconnecting?.(reconnectAttempt);
        await sleepImpl(reconnectDelayMs(reconnectAttempt));
        continue;
      }
      if (closed) return;
      statusFailures = 0;
      if (receivedFrame) {
        reconnectAttempt = 0;
      }
      handlers.onStatus(status);
      if (RUN_TERMINAL_STATUSES.has(status)) return;

      reconnectAttempt += 1;
      handlers.onReconnecting?.(reconnectAttempt);
      await sleepImpl(reconnectDelayMs(reconnectAttempt));
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
