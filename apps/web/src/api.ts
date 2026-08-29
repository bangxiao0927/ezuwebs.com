import type {
  ApprovalDecision,
  PatchStrategy,
  Session,
  SessionSummary,
  WebEditorProperty,
  WorkspaceFile,
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });

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
    throw new Error(message);
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
  },
): Promise<Session> {
  const data = await request<{ session: Session }>(
    `/sessions/${encodeURIComponent(sessionId)}/edit`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return data.session;
}

export async function sendPrompt(sessionId: string, text: string): Promise<Session> {
  const data = await request<{ session: Session }>(
    `/sessions/${encodeURIComponent(sessionId)}/prompt`,
    {
      method: "POST",
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
