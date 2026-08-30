import type {
  ApprovalDecision,
  AuthUser,
  BillingSummary,
  Dashboard,
  PatchStrategy,
  RunDto,
  Session,
  SessionSummary,
  UsagePage,
  WebEditorProperty,
  WorkspaceFile,
} from "./types";

import { ApiError } from "./apiError";
import { openRunEventStream, type RunEventStreamHandle, type RunEventStreamHandlers } from "./lib/runEventStream";

export { ApiError };
export type { RunEventStreamHandle, RunEventStreamHandlers };

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      credentials: "same-origin",
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers as Record<string, string> | undefined) },
    });
  } catch (cause) {
    throw new Error(cause instanceof Error ? cause.message : "Network request failed");
  }

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) {
        message = payload.error;
      }
    } catch {
      // Ignore non-JSON error bodies.
    }
    throw new ApiError(message, response.status);
  }

  return (await response.json()) as T;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const data = await request<{ sessions: SessionSummary[] }>("/sessions");
  return data.sessions;
}

export async function createSession(definitionId: string): Promise<Session> {
  const data = await request<{ session: Session }>("/sessions", {
    method: "POST",
    body: JSON.stringify({ definitionId }),
  });
  return data.session;
}

export function googleSignInUrl(): string {
  return `${API_BASE}/auth/google`;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const data = await request<{ user: AuthUser | null }>("/auth/me");
  return data.user;
}

export async function logout(): Promise<void> {
  await request<{ ok: boolean }>("/auth/logout", { method: "POST" });
}

export async function getDashboard(): Promise<Dashboard> {
  return request<Dashboard>("/dashboard");
}

export async function getSession(sessionId: string): Promise<Session> {
  const data = await request<{ session: Session }>(`/sessions/${encodeURIComponent(sessionId)}`);
  return data.session;
}

export async function getWorkspaceFiles(sessionId: string): Promise<WorkspaceFile[]> {
  const data = await request<{ files: WorkspaceFile[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/files`,
  );
  return data.files;
}

export async function selectBlock(sessionId: string, blockId: string): Promise<Session> {
  const data = await request<{ session: Session }>(
    `/sessions/${encodeURIComponent(sessionId)}/select-block`,
    {
      method: "POST",
      body: JSON.stringify({ blockId }),
    },
  );
  return data.session;
}

export async function applyEdit(
  sessionId: string,
  input: {
    intent: string;
    patchStrategy: PatchStrategy;
    properties?: WebEditorProperty[];
    runAgent?: boolean;
    requestId: string;
  },
): Promise<Session> {
  const { requestId, ...body } = input;
  const data = await request<{ session: Session }>(
    `/sessions/${encodeURIComponent(sessionId)}/edit`,
    {
      method: "POST",
      headers: { "idempotency-key": requestId },
      body: JSON.stringify(body),
    },
  );
  return data.session;
}

export async function sendPrompt(sessionId: string, text: string, requestId: string): Promise<Session> {
  const data = await request<{ session: Session }>(
    `/sessions/${encodeURIComponent(sessionId)}/prompt`,
    {
      method: "POST",
      headers: { "idempotency-key": requestId },
      body: JSON.stringify({ text }),
    },
  );
  return data.session;
}

export async function resolveApproval(
  sessionId: string,
  interactionId: string,
  decision: ApprovalDecision,
  reason: string,
): Promise<Session> {
  const data = await request<{ session: Session }>(
    `/sessions/${encodeURIComponent(sessionId)}/approval`,
    {
      method: "POST",
      body: JSON.stringify({ interactionId, decision, reason }),
    },
  );
  return data.session;
}

export async function resolveChoice(
  sessionId: string,
  interactionId: string,
  optionId: string,
): Promise<Session> {
  const data = await request<{ session: Session }>(
    `/sessions/${encodeURIComponent(sessionId)}/interaction`,
    {
      method: "POST",
      body: JSON.stringify({ interactionId, optionId }),
    },
  );
  return data.session;
}

export async function resolveInput(
  sessionId: string,
  interactionId: string,
  value: string,
): Promise<Session> {
  const data = await request<{ session: Session }>(
    `/sessions/${encodeURIComponent(sessionId)}/interaction`,
    {
      method: "POST",
      body: JSON.stringify({ interactionId, value }),
    },
  );
  return data.session;
}

export async function getBillingSummary(): Promise<BillingSummary> {
  return request<BillingSummary>("/billing/summary");
}

export async function getUsage(options: { limit?: number; offset?: number } = {}): Promise<UsagePage> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options.offset !== undefined) {
    params.set("offset", String(options.offset));
  }
  const query = params.toString();
  return request<UsagePage>(`/billing/usage${query ? `?${query}` : ""}`);
}

export async function grantDevCredits(packageId: string): Promise<BillingSummary> {
  return request<BillingSummary>("/billing/dev-grant", {
    method: "POST",
    body: JSON.stringify({ packageId }),
  });
}

export async function createPromptRun(sessionId: string, text: string, requestId: string): Promise<RunDto> {
  const data = await request<{ run: RunDto }>(`/sessions/${encodeURIComponent(sessionId)}/runs`, {
    method: "POST",
    headers: { "idempotency-key": requestId },
    body: JSON.stringify({ kind: "prompt", text, requestId }),
  });
  return data.run;
}

export async function getRun(sessionId: string, runId: string): Promise<RunDto> {
  const data = await request<{ run: RunDto }>(
    `/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}`,
  );
  return data.run;
}

export async function cancelRun(sessionId: string, runId: string): Promise<RunDto> {
  const data = await request<{ run: RunDto }>(
    `/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );
  return data.run;
}

export async function listActiveRuns(sessionId: string): Promise<RunDto[]> {
  const data = await request<{ runs: RunDto[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/runs?active=true`,
  );
  return data.runs;
}

/** Streams a run's agent events over SSE, reconnecting on drop until it reaches a terminal status. */
export function streamRunEvents(
  sessionId: string,
  runId: string,
  handlers: RunEventStreamHandlers,
): RunEventStreamHandle {
  return openRunEventStream(sessionId, runId, handlers, { apiBase: API_BASE });
}
