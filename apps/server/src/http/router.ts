import { type IncomingMessage, type ServerResponse } from "node:http";

import type { AuthServicePort } from "./auth-routes.js";
import { handleAuthRoute } from "./auth-routes.js";
import { handleBillingRoute } from "./billing-routes.js";
import { MAX_JSON_BODY_BYTES, PayloadTooLargeError, readJsonBody } from "./body.js";
import { parseCookies } from "./cookies.js";
import { corsHeaders, resolveAllowedOrigin } from "./cors.js";
import { resolveRequestId } from "./idempotency.js";
import { isBillingEnabled, RefundConflictError } from "../domain/billing/billing-service.js";
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
  InsufficientCreditsError,
  InteractionConflictError,
  InteractionValidationError,
  MissingIdempotencyKeyError,
  PreviousAttemptFailedError,
  SessionNotFoundError,
  UnknownSessionDefinitionError,
  selectBlock,
  sendPrompt,
} from "../domain/sessions.js";
import { getDashboard } from "../domain/dashboard.js";
import {
  SessionRowMissingError,
  SessionSaveConflictError,
} from "../domain/sqlite-session-repository.js";
import {
  cancelRun,
  createRun,
  getRun,
  listRunEvents,
  RunNotFoundError,
} from "../domain/run-service.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

interface JsonError {
  error: string;
}

function sendJsonWithCors(
  response: ServerResponse,
  status: number,
  payload: unknown,
  allowedOrigin: string | undefined,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders(allowedOrigin),
  });
  response.end(body);
}

const RUN_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const SSE_POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Streams run events as SSE: replays everything after `afterSeq`, then keeps
 * polling for new events until the run reaches a terminal status and every
 * event up to that point has been sent. Polling (rather than a live
 * subscription that starts after replay) means there is no window in which
 * an event appended between "replay" and "subscribe" could be missed.
 */
async function streamRunEvents(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigin: string | undefined,
  sessionId: string,
  runId: string,
  afterSeq: number,
  requestingUserId: string | undefined,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "connection": "keep-alive",
    ...corsHeaders(allowedOrigin),
  });

  let cursor = afterSeq;
  let clientDisconnected = false;
  request.on("close", () => {
    clientDisconnected = true;
  });

  while (!clientDisconnected) {
    const events = await listRunEvents(sessionId, runId, cursor, requestingUserId);
    for (const entry of events) {
      response.write(`id: ${entry.seq}\nevent: agent\ndata: ${JSON.stringify(entry.event)}\n\n`);
      cursor = entry.seq;
    }

    const run = await getRun(sessionId, runId, requestingUserId);
    if (RUN_TERMINAL_STATUSES.has(run.status) && cursor >= run.lastEventSeq) {
      break;
    }
    if (clientDisconnected) break;
    response.write(`: heartbeat\n\n`);
    await sleep(SSE_POLL_INTERVAL_MS);
  }

  response.end();
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

/**
 * Resolves the signed-in user for a billed action (edit/prompt/retry) or for
 * creating a session, which is gated the same way to stop anonymous storage
 * abuse once billing is enabled. Unlike `resolveCurrentUserId`, auth
 * resolution failures are never swallowed into "anonymous" here: when
 * billing is enabled, a broken auth service must surface as an error, not
 * silently bypass the boundary.
 */
async function resolveCurrentUserIdForBilledAction(
  request: IncomingMessage,
  options: CreateApiHandlerOptions,
): Promise<string | undefined> {
  if (!isBillingEnabled()) {
    return resolveCurrentUserId(request, options);
  }
  const authService = options.authService ?? (await resolveDefaultAuthService());
  const sessionCookieValue = parseCookies(request.headers.cookie)[authService.sessionCookieName];
  const user = await authService.getCurrentUser(sessionCookieValue);
  return user?.id;
}

function errorStatus(error: unknown): number {
  if (error instanceof PayloadTooLargeError) return 413;
  if (error instanceof SessionNotFoundError) return 404;
  if (error instanceof SessionRowMissingError) return 404;
  if (error instanceof SessionSaveConflictError) return 409;
  if (error instanceof UnknownSessionDefinitionError) return 400;
  if (error instanceof InteractionConflictError) return 409;
  if (error instanceof InteractionValidationError) return 400;
  if (error instanceof ActionRetryConflictError) return 409;
  if (error instanceof InsufficientCreditsError) return 402;
  if (error instanceof MissingIdempotencyKeyError) return 400;
  if (error instanceof PreviousAttemptFailedError) return 409;
  if (error instanceof RefundConflictError) return 409;
  if (error instanceof RunNotFoundError) return 404;
  return 500;
}

export function createApiHandler(options: CreateApiHandlerOptions = {}): Handler {
  return async (request, response) => {
    const originHeader = request.headers.origin;
    const allowedOrigin = resolveAllowedOrigin(typeof originHeader === "string" ? originHeader : undefined);
    const sendJson = (res: ServerResponse, status: number, payload: unknown): void =>
      sendJsonWithCors(res, status, payload, allowedOrigin);

    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://localhost");
      const segments = url.pathname.split("/").filter(Boolean);

      if (method === "OPTIONS") {
        response.writeHead(204, {
          ...corsHeaders(allowedOrigin),
          ...(allowedOrigin
            ? {
                "access-control-allow-headers": "content-type, idempotency-key",
                "access-control-allow-methods": "GET,POST,OPTIONS",
              }
            : {}),
        });
        response.end();
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

      if (segments[1] === "billing") {
        const authService = options.authService ?? (await resolveDefaultAuthService());
        const handled = await handleBillingRoute(segments, method, request, response, authService, sendJson);
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
        const body = await readJsonBody<{ definitionId?: string }>(request, MAX_JSON_BODY_BYTES);
        const currentUserId = await resolveCurrentUserIdForBilledAction(request, options);
        if (isBillingEnabled() && !currentUserId) {
          sendJson(response, 401, { error: "Authentication required" } satisfies JsonError);
          return;
        }
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
            requestId?: string;
          }>(request);
          const willCharge = body.runAgent !== false;
          const billedCurrentUserId = willCharge
            ? await resolveCurrentUserIdForBilledAction(request, options)
            : currentUserId;
          if (willCharge && isBillingEnabled() && !billedCurrentUserId) {
            sendJson(response, 401, { error: "Authentication required" } satisfies JsonError);
            return;
          }
          const requestId = resolveRequestId(request, body);
          if (willCharge && isBillingEnabled() && billedCurrentUserId && !requestId) {
            sendJson(response, 400, {
              error: "An Idempotency-Key header or requestId is required",
            } satisfies JsonError);
            return;
          }
          const session = await applyEdit(
            sessionId,
            {
              intent: body.intent ?? "",
              patchStrategy: body.patchStrategy ?? "refine",
              ...(body.properties ? { properties: body.properties } : {}),
              ...(typeof body.runAgent === "boolean" ? { runAgent: body.runAgent } : {}),
              ...(requestId ? { requestId } : {}),
            },
            billedCurrentUserId,
          );
          sendJson(response, 200, { session });
          return;
        }

        if (action === "prompt" && method === "POST") {
          const body = await readJsonBody<{ text?: string; requestId?: string }>(request);
          const text = (body.text ?? "").trim();
          if (!text) {
            sendJson(response, 400, { error: "Prompt text is required" } satisfies JsonError);
            return;
          }
          const billedCurrentUserId = await resolveCurrentUserIdForBilledAction(request, options);
          if (isBillingEnabled() && !billedCurrentUserId) {
            sendJson(response, 401, { error: "Authentication required" } satisfies JsonError);
            return;
          }
          const requestId = resolveRequestId(request, body);
          if (isBillingEnabled() && billedCurrentUserId && !requestId) {
            sendJson(response, 400, {
              error: "An Idempotency-Key header or requestId is required",
            } satisfies JsonError);
            return;
          }
          sendJson(response, 200, { session: await sendPrompt(sessionId, text, billedCurrentUserId, requestId) });
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
          // Approving executes real agent work, so it must go through the
          // same auth boundary as the prompt/edit that created it, even
          // though the credit for that work was already charged there.
          const billedCurrentUserId = await resolveCurrentUserIdForBilledAction(request, options);
          if (isBillingEnabled() && !billedCurrentUserId) {
            sendJson(response, 401, { error: "Authentication required" } satisfies JsonError);
            return;
          }
          const decision = body.decision as "approved" | "rejected";
          const session = await resolveApproval(
            sessionId,
            body.interactionId,
            decision,
            body.reason ?? "Replacement requested.",
            billedCurrentUserId,
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
          const body = await readJsonBody<{ requestId?: string }>(request);
          const billedCurrentUserId = await resolveCurrentUserIdForBilledAction(request, options);
          if (isBillingEnabled() && !billedCurrentUserId) {
            sendJson(response, 401, { error: "Authentication required" } satisfies JsonError);
            return;
          }
          const requestId = resolveRequestId(request, body);
          if (isBillingEnabled() && billedCurrentUserId && !requestId) {
            sendJson(response, 400, {
              error: "An Idempotency-Key header or requestId is required",
            } satisfies JsonError);
            return;
          }
          const session = await retryAction(sessionId, actionId, billedCurrentUserId, requestId);
          sendJson(response, 200, { session });
          return;
        }

        if (action === "runs" && !segments[4] && method === "POST") {
          const body = await readJsonBody<{ kind?: string; text?: string; requestId?: string }>(request);
          const text = (body.text ?? "").trim();
          if (!text) {
            sendJson(response, 400, { error: "Prompt text is required" } satisfies JsonError);
            return;
          }
          const billedCurrentUserId = await resolveCurrentUserIdForBilledAction(request, options);
          if (isBillingEnabled() && !billedCurrentUserId) {
            sendJson(response, 401, { error: "Authentication required" } satisfies JsonError);
            return;
          }
          const requestId = resolveRequestId(request, body);
          if (isBillingEnabled() && billedCurrentUserId && !requestId) {
            sendJson(response, 400, {
              error: "An Idempotency-Key header or requestId is required",
            } satisfies JsonError);
            return;
          }
          const run = await createRun(
            sessionId,
            { kind: "prompt", text, ...(requestId ? { requestId } : {}) },
            billedCurrentUserId,
          );
          sendJson(response, 202, { run });
          return;
        }

        if (action === "runs" && segments[4] && !segments[5] && method === "GET") {
          const runId = decodeURIComponent(segments[4]!);
          const run = await getRun(sessionId, runId, currentUserId);
          sendJson(response, 200, { run });
          return;
        }

        if (action === "runs" && segments[4] && segments[5] === "events" && method === "GET") {
          const runId = decodeURIComponent(segments[4]!);
          const afterSeqParam = url.searchParams.get("afterSeq");
          const afterSeq = afterSeqParam === null ? 0 : Number(afterSeqParam);
          if (!Number.isInteger(afterSeq) || afterSeq < 0) {
            sendJson(response, 400, { error: "afterSeq must be a non-negative integer" } satisfies JsonError);
            return;
          }
          // Ownership check up front: a stream that fails mid-flight cannot
          // change its response status once headers are already written.
          await getRun(sessionId, runId, currentUserId);
          await streamRunEvents(request, response, allowedOrigin, sessionId, runId, afterSeq, currentUserId);
          return;
        }

        if (action === "runs" && segments[4] && segments[5] === "cancel" && method === "POST") {
          const runId = decodeURIComponent(segments[4]!);
          const billedCurrentUserId = await resolveCurrentUserIdForBilledAction(request, options);
          if (isBillingEnabled() && !billedCurrentUserId) {
            sendJson(response, 401, { error: "Authentication required" } satisfies JsonError);
            return;
          }
          const run = await cancelRun(sessionId, runId, billedCurrentUserId);
          sendJson(response, 200, { run });
          return;
        }
      }

      sendJson(response, 404, { error: "Not found" } satisfies JsonError);
    } catch (error) {
      sendJson(response, errorStatus(error), {
        error: error instanceof Error ? error.message : "Internal server error",
      } satisfies JsonError);
    }
  };
}
