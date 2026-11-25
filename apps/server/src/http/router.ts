import { type IncomingMessage, type ServerResponse } from "node:http";

import {
  applyEdit,
  createSession,
  getSession,
  getSessionWorkspaceFiles,
  listSessionDefinitions,
  resolveApproval,
  selectBlock,
  sendPrompt,
  SessionDefinitionNotFoundError,
  SessionNotFoundError,
} from "../domain/sessions.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

interface JsonError {
  error: string;
}

const MAX_JSON_BODY_BYTES = 1024 * 1024;

class RequestBodyTooLargeError extends Error {}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > MAX_JSON_BODY_BYTES) {
      throw new RequestBodyTooLargeError("Request body exceeds 1 MiB");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}

export function createApiHandler(): Handler {
  return async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://localhost");
      const segments = url.pathname.split("/").filter(Boolean);

      // Health probe.
      if (segments.length === 1 && segments[0] === "api" && method === "GET") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      // All API routes live under /api.
      if (segments[0] !== "api") {
        sendJson(response, 404, { error: "Not found" } satisfies JsonError);
        return;
      }

      // GET /api/sessions
      if (segments.length === 2 && segments[1] === "sessions" && method === "GET") {
        sendJson(response, 200, { sessions: listSessionDefinitions() });
        return;
      }

      // POST /api/sessions { definitionId }
      if (segments.length === 2 && segments[1] === "sessions" && method === "POST") {
        const body = await readJsonBody<{ definitionId?: string }>(request);
        const session = await createSession(body.definitionId ?? "club-promo");
        sendJson(response, 201, { session });
        return;
      }

      // /api/sessions/:id ...
      if (segments.length >= 3 && segments[1] === "sessions") {
        const sessionId = decodeURIComponent(segments[2]!);
        const action = segments[3];

        if (!action && method === "GET") {
          sendJson(response, 200, { session: await getSession(sessionId) });
          return;
        }

        if (action === "files" && method === "GET") {
          sendJson(response, 200, { files: await getSessionWorkspaceFiles(sessionId) });
          return;
        }

        if (action === "select-block" && method === "POST") {
          const body = await readJsonBody<{ blockId?: string }>(request);
          const session = await selectBlock(sessionId, body.blockId ?? "workbench");
          sendJson(response, 200, { session });
          return;
        }

        if (action === "edit" && method === "POST") {
          const body = await readJsonBody<{
            intent?: string;
            patchStrategy?: "replace" | "append" | "refine";
            properties?: Array<{ key: string; label: string; value: string }>;
            runAgent?: boolean;
          }>(request);
          const session = await applyEdit(sessionId, {
            intent: body.intent ?? "",
            patchStrategy: body.patchStrategy ?? "refine",
            ...(body.properties ? { properties: body.properties } : {}),
            ...(typeof body.runAgent === "boolean" ? { runAgent: body.runAgent } : {}),
          });
          sendJson(response, 200, { session });
          return;
        }

        if (action === "prompt" && method === "POST") {
          const body = await readJsonBody<{ text?: string }>(request);
          const text = (body.text ?? "").trim();
          if (!text) {
            sendJson(response, 400, { error: "Prompt text is required" } satisfies JsonError);
            return;
          }
          sendJson(response, 200, { session: await sendPrompt(sessionId, text) });
          return;
        }

        if (action === "approval" && method === "POST") {
          const body = await readJsonBody<{ decision?: string; reason?: string }>(request);
          if (body.decision !== "approved" && body.decision !== "rejected") {
            sendJson(response, 400, { error: "A valid approval decision is required" } satisfies JsonError);
            return;
          }
          const decision = body.decision;
          const session = await resolveApproval(
            sessionId,
            decision,
            body.reason ?? "Replacement requested.",
          );
          sendJson(response, 200, { session });
          return;
        }
      }

      sendJson(response, 404, { error: "Not found" } satisfies JsonError);
    } catch (error) {
      if (error instanceof SyntaxError) {
        sendJson(response, 400, { error: "Request body must be valid JSON" } satisfies JsonError);
        return;
      }
      if (error instanceof RequestBodyTooLargeError) {
        sendJson(response, 413, { error: error.message } satisfies JsonError);
        return;
      }
      if (error instanceof SessionNotFoundError) {
        sendJson(response, 404, { error: error.message } satisfies JsonError);
        return;
      }
      if (error instanceof SessionDefinitionNotFoundError) {
        sendJson(response, 400, { error: error.message } satisfies JsonError);
        return;
      }
      console.error("[ezu/server] Unhandled API error", error);
      sendJson(response, 500, { error: "Internal server error" } satisfies JsonError);
    }
  };
}
