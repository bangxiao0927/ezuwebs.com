import { type IncomingMessage, type ServerResponse } from "node:http";

import type { AuthServicePort } from "./auth-routes.js";
import { handleAuthRoute } from "./auth-routes.js";
import { parseCookies } from "./cookies.js";
import {
  applyEdit,
  createSession,
  getSession,
  getSessionWorkspaceFiles,
  listSessionDefinitions,
  resolveApproval,
  resolveChoiceInteraction,
  resolveInputInteraction,
  retryAction,
  ActionRetryConflictError,
  InteractionConflictError,
  InteractionValidationError,
  SessionNotFoundError,
  selectBlock,
  sendPrompt,
} from "../domain/sessions.js";
import { getDashboard } from "../domain/dashboard.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

interface JsonError {
  error: string;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  response.end(body);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}

export interface CreateApiHandlerOptions {
  authService?: AuthServicePort;
}

let cachedDefaultAuthService: AuthServicePort | undefined;

async function resolveDefaultAuthService(): Promise<AuthServicePort> {
  if (!cachedDefaultAuthService) {
    // Deferred so importing the router never pulls in the better-sqlite3 native binding.
    const { createDefaultAuthService } = await import("../domain/auth/default-auth-service.js");
    cachedDefaultAuthService = createDefaultAuthService();
  }
  return cachedDefaultAuthService;
}

/**
 * Resolves the id of the signed-in user from the session cookie, if any.
 * Any failure to resolve an auth service (e.g. Google credentials not
 * configured) is treated as "anonymous" so demo session routes keep working
 * without auth configured.
 */
async function resolveCurrentUserId(
  request: IncomingMessage,
  options: CreateApiHandlerOptions,
): Promise<string | undefined> {
  try {
    const authService = options.authService ?? (await resolveDefaultAuthService());
    const sessionCookieValue = parseCookies(request.headers.cookie)[authService.sessionCookieName];
    const user = await authService.getCurrentUser(sessionCookieValue);
    return user?.id;
  } catch {
    return undefined;
  }
}

export function createApiHandler(options: CreateApiHandlerOptions = {}): Handler {
  return async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://localhost");
      const segments = url.pathname.split("/").filter(Boolean);

      if (method === "OPTIONS") {
        sendJson(response, 204, {});
        return;
      }

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

      if (segments[1] === "auth") {
        const authService = options.authService ?? (await resolveDefaultAuthService());
        const handled = await handleAuthRoute(segments, method, request, response, authService, sendJson);
        if (handled) {
          return;
        }
      }

      // GET /api/dashboard
      if (segments.length === 2 && segments[1] === "dashboard" && method === "GET") {
        const authService = options.authService ?? (await resolveDefaultAuthService());
        const sessionCookieValue = parseCookies(request.headers.cookie)[authService.sessionCookieName];
        const user = await authService.getCurrentUser(sessionCookieValue);
        if (!user) {
          sendJson(response, 401, { error: "Authentication required" } satisfies JsonError);
          return;
        }
        sendJson(response, 200, await getDashboard(user));
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
        const currentUserId = await resolveCurrentUserId(request, options);
        const session = await createSession(body.definitionId ?? "club-promo", currentUserId);
        sendJson(response, 201, { session });
        return;
      }

      // /api/sessions/:id ...
      if (segments.length >= 3 && segments[1] === "sessions") {
        const sessionId = decodeURIComponent(segments[2]!);
        const action = segments[3];
        const currentUserId = await resolveCurrentUserId(request, options);

        if (!action && method === "GET") {
          sendJson(response, 200, { session: await getSession(sessionId, currentUserId) });
          return;
        }

        if (action === "files" && method === "GET") {
          sendJson(response, 200, { files: await getSessionWorkspaceFiles(sessionId, currentUserId) });
          return;
        }

        if (action === "select-block" && method === "POST") {
          const body = await readJsonBody<{ blockId?: string }>(request);
          const session = await selectBlock(sessionId, body.blockId ?? "workbench", currentUserId);
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
          const session = await applyEdit(
            sessionId,
            {
              intent: body.intent ?? "",
              patchStrategy: body.patchStrategy ?? "refine",
              ...(body.properties ? { properties: body.properties } : {}),
              ...(typeof body.runAgent === "boolean" ? { runAgent: body.runAgent } : {}),
            },
            currentUserId,
          );
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
          sendJson(response, 200, { session: await sendPrompt(sessionId, text, currentUserId) });
          return;
        }

        if (action === "approval" && method === "POST") {
          const body = await readJsonBody<{
            interactionId?: string;
            decision?: string;
            reason?: string;
          }>(request);
          if (!body.interactionId || !["approved", "rejected"].includes(body.decision ?? "")) {
            sendJson(response, 400, { error: "interactionId and a valid decision are required" });
            return;
          }
          const decision = body.decision as "approved" | "rejected";
          const session = await resolveApproval(
            sessionId,
            body.interactionId,
            decision,
            body.reason ?? "Replacement requested.",
            currentUserId,
          );
          sendJson(response, 200, { session });
          return;
        }

        if (action === "interaction" && method === "POST") {
          const body = await readJsonBody<{
            interactionId?: string;
            optionId?: string;
            value?: string;
          }>(request);
          if (!body.interactionId) {
            sendJson(response, 400, { error: "interactionId is required" });
            return;
          }
          if (typeof body.optionId === "string") {
            const session = await resolveChoiceInteraction(
              sessionId,
              body.interactionId,
              body.optionId,
              currentUserId,
            );
            sendJson(response, 200, { session });
            return;
          }
          if (typeof body.value === "string") {
            const session = await resolveInputInteraction(
              sessionId,
              body.interactionId,
              body.value,
              currentUserId,
            );
            sendJson(response, 200, { session });
            return;
          }
          sendJson(response, 400, { error: "optionId or value is required" });
          return;
        }

        if (action === "actions" && segments[5] === "retry" && method === "POST") {
          const actionId = decodeURIComponent(segments[4]!);
          sendJson(response, 200, { session: await retryAction(sessionId, actionId, currentUserId) });
          return;
        }
      }

      sendJson(response, 404, { error: "Not found" } satisfies JsonError);
    } catch (error) {
      const status =
        error instanceof SessionNotFoundError
          ? 404
          : error instanceof InteractionConflictError
            ? 409
            : error instanceof InteractionValidationError
              ? 400
            : error instanceof ActionRetryConflictError
              ? 409
            : 500;
      sendJson(response, status, {
        error: error instanceof Error ? error.message : "Internal server error",
      } satisfies JsonError);
    }
  };
}
