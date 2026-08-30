import type { IncomingMessage, ServerResponse } from "node:http";

import { CommandPolicyError } from "../commands/command-policy.js";
import { CommandNotFoundError, CommandValidationError } from "../commands/command-service.js";
import type { WorkerConfig } from "../config.js";
import {
  ImageNotAllowedError,
  RuntimeNotFoundError,
  RuntimeCapacityError,
  type RuntimeService,
} from "../runtime-service.js";
import { PreviewPortNotAllowedError } from "../preview/preview-service.js";
import {
  WorkspaceConflictError,
  WorkspaceNotFoundError,
  WorkspaceQuotaError,
} from "../workspace/workspace-service.js";
import { WorkspacePathError } from "../workspace/path-validation.js";
import { isAuthorized } from "./auth.js";
import { MAX_JSON_BODY_BYTES, PayloadTooLargeError, readJsonBody } from "./body.js";

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json");
  response.writeHead(status);
  response.end(JSON.stringify(payload));
}

function genericError(response: ServerResponse, status: number, error: string): void {
  sendJson(response, status, { error });
}

/** Maps a thrown error to a generic HTTP response, never leaking host paths, command output, or the auth token. */
function handleError(response: ServerResponse, error: unknown): void {
  if (
    error instanceof RuntimeNotFoundError ||
    error instanceof WorkspaceNotFoundError ||
    error instanceof CommandNotFoundError
  ) {
    genericError(response, 404, "not_found");
    return;
  }
  if (error instanceof WorkspaceConflictError) {
    genericError(response, 409, "conflict");
    return;
  }
  if (error instanceof RuntimeCapacityError) {
    genericError(response, 429, "capacity_exceeded");
    return;
  }
  if (
    error instanceof WorkspaceQuotaError ||
    error instanceof WorkspacePathError ||
    error instanceof ImageNotAllowedError ||
    error instanceof CommandPolicyError ||
    error instanceof CommandValidationError ||
    error instanceof PreviewPortNotAllowedError ||
    error instanceof PayloadTooLargeError
  ) {
    genericError(response, 400, "bad_request");
    return;
  }
  genericError(response, 500, "internal_error");
}

function readQuery(url: URL, key: string): string | undefined {
  return url.searchParams.get(key) ?? undefined;
}

async function servePreview(
  runtimeService: RuntimeService,
  segments: string[],
  response: ServerResponse,
): Promise<void> {
  const token = segments[1];
  if (!token) {
    genericError(response, 404, "not_found");
    return;
  }

  const resolved = runtimeService.resolvePreview(token);
  if (!resolved) {
    genericError(response, 404, "not_found");
    return;
  }

  try {
    const file = await runtimeService.readFile(resolved.runtimeId, "index.html");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    );
    response.writeHead(200);
    response.end(file.content);
  } catch {
    genericError(response, 404, "not_found");
  }
}

export function createRuntimeWorkerHandler(
  config: WorkerConfig,
  runtimeService: RuntimeService,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://internal");
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    const method = request.method ?? "GET";

    if (segments[0] === "p") {
      if (method !== "GET") {
        genericError(response, 405, "method_not_allowed");
        return;
      }
      await servePreview(runtimeService, segments, response);
      return;
    }

    if (segments[0] !== "internal" || segments[1] !== "runtime" || segments[2] !== "v1" || segments[3] !== "runtimes") {
      genericError(response, 404, "not_found");
      return;
    }

    if (!isAuthorized(request.headers.authorization, config.apiToken)) {
      genericError(response, 401, "unauthorized");
      return;
    }

    const runtimeId = segments[4];

    try {
      if (segments.length === 4 && method === "POST") {
        const body = await readJsonBody<{
          sessionId: string;
          projectId: string;
          image: string;
          profile: string;
          seed?: { files: { path: string; content: string }[] };
        }>(request, MAX_JSON_BODY_BYTES);
        const created = await runtimeService.createRuntime(body);
        sendJson(response, 201, created);
        return;
      }

      if (!runtimeId) {
        genericError(response, 404, "not_found");
        return;
      }

      if (segments.length === 5 && method === "DELETE") {
        await runtimeService.deleteRuntime(runtimeId);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (segments.length === 6 && segments[5] === "files") {
        if (method === "GET") {
          const path = readQuery(url, "path") ?? "";
          const file = await runtimeService.readFile(runtimeId, path);
          sendJson(response, 200, { content: file.content, version: file.version });
          return;
        }
        if (method === "PUT") {
          const body = await readJsonBody<{ path: string; content: string; expectedVersion?: string }>(request);
          const result = await runtimeService.writeFile(runtimeId, body.path, body.content, body.expectedVersion);
          sendJson(response, 200, result);
          return;
        }
        if (method === "PATCH") {
          const body = await readJsonBody<{ path: string; patch: string }>(request);
          const result = await runtimeService.patchFile(runtimeId, body.path, body.patch);
          sendJson(response, 200, result);
          return;
        }
        if (method === "DELETE") {
          const path = readQuery(url, "path") ?? "";
          await runtimeService.deleteFile(runtimeId, path);
          sendJson(response, 200, { ok: true });
          return;
        }
      }

      if (segments.length === 7 && segments[5] === "files" && segments[6] === "list" && method === "GET") {
        const root = readQuery(url, "root") ?? "";
        const limitRaw = readQuery(url, "limit");
        const cursor = readQuery(url, "cursor");
        const result = await runtimeService.listFiles(runtimeId, root, {
          ...(limitRaw ? { limit: Number.parseInt(limitRaw, 10) } : {}),
          ...(cursor ? { cursor } : {}),
        });
        sendJson(response, 200, result);
        return;
      }

      if (segments.length === 7 && segments[5] === "files" && segments[6] === "snapshot" && method === "GET") {
        const result = await runtimeService.snapshotFiles(runtimeId);
        sendJson(response, 200, result);
        return;
      }

      if (segments.length === 6 && segments[5] === "commands" && method === "POST") {
        const body = await readJsonBody<{
          argv: string[];
          cwd?: string;
          timeoutMs: number;
          maxOutputBytes: number;
          policy: string;
        }>(request);
        const result = runtimeService.createCommand(runtimeId, body);
        sendJson(response, 202, result);
        return;
      }

      if (segments.length === 7 && segments[5] === "commands" && method === "GET") {
        const commandId = segments[6]!;
        const status = runtimeService.getCommandStatus(runtimeId, commandId);
        if (!status) {
          genericError(response, 404, "not_found");
          return;
        }
        sendJson(response, 200, status);
        return;
      }

      if (segments.length === 8 && segments[5] === "commands" && segments[7] === "events" && method === "GET") {
        const commandId = segments[6]!;
        const afterSeq = Number.parseInt(readQuery(url, "afterSeq") ?? "0", 10);
        const result = runtimeService.getCommandEvents(runtimeId, commandId, afterSeq);
        sendJson(response, 200, result);
        return;
      }

      if (segments.length === 8 && segments[5] === "commands" && segments[7] === "cancel" && method === "POST") {
        const commandId = segments[6]!;
        await runtimeService.cancelCommand(runtimeId, commandId);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (segments.length === 6 && segments[5] === "previews" && method === "POST") {
        const body = await readJsonBody<{ port?: number }>(request);
        const result = runtimeService.createPreview(runtimeId, body.port);
        sendJson(response, 201, result);
        return;
      }

      if (segments.length === 6 && segments[5] === "events" && method === "GET") {
        const afterSeq = Number.parseInt(readQuery(url, "afterSeq") ?? "0", 10);
        const result = runtimeService.getEvents(runtimeId, afterSeq);
        sendJson(response, 200, result);
        return;
      }

      genericError(response, 404, "not_found");
    } catch (error) {
      handleError(response, error);
    }
  };
}
