import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

interface RuntimeEvent {
  seq: number;
  type: "file.changed" | "port.changed";
  path?: string;
  changeType?: string;
  port?: number;
  url?: string;
  status?: "open" | "close";
}

interface CommandEvent {
  seq: number;
  type: "output" | "exit";
  chunk?: string;
  code?: number;
}

interface FakeCommand {
  argv: string[];
  status: "running" | "exited";
  exitCode?: number;
  events: CommandEvent[];
  hang: boolean;
}

interface FakeRuntime {
  runtimeId: string;
  sessionId: string;
  projectId: string;
  files: Map<string, string>;
  commands: Map<string, FakeCommand>;
  events: RuntimeEvent[];
  createBody: unknown;
}

export interface FakeWorkerServerOptions {
  /** Overrides the runtimeId assigned to `/runtimes` create calls (default: "runtime-1", "runtime-2", ...). */
  runtimeIdPrefix?: string;
  /** If set, the create-runtime response reports this sessionId instead of the request's, to test mismatch handling. */
  respondWithSessionId?: string;
  /** Origin used to build preview URLs, e.g. "https://preview.example.test". */
  previewOrigin?: string;
  /** Adds an artificial delay (ms) before responding to every request. */
  responseDelayMs?: number;
  /** Never responds to matching paths, to simulate a hung connection for timeout tests. */
  hangOnPath?: (path: string) => boolean;
  /** Sends response headers but never finishes the body for matching paths, to simulate a stalled read. */
  hangAfterHeadersOnPath?: (path: string) => boolean;
  /** Overrides the HTTP status and body for matching requests, to simulate worker errors. */
  failOn?: (method: string, path: string) => { status: number; body: string } | undefined;
  /** Sends a redirect status and Location header for matching requests, to test that redirects are never followed. */
  redirectOnPath?: (method: string, path: string) => { status: number; location: string } | undefined;
  /** Sends a response body larger than this many bytes for matching requests, to simulate a runaway response. */
  oversizedBodyOnPath?: (path: string) => number | undefined;
  /** Replaces a 200 JSON response body for matching requests, to simulate a worker response that fails schema validation. */
  overrideResponseBodyOnPath?: (method: string, path: string) => unknown | undefined;
}

export interface FakeWorkerServer {
  url: string;
  requests: RecordedRequest[];
  runtimes: Map<string, FakeRuntime>;
  close(): Promise<void>;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(text);
}

/**
 * A minimal in-memory stand-in for a production sandbox worker's HTTP API,
 * used only to test RemoteRuntimeAdapter's HTTP contract against something
 * real. It has no container isolation, no persistence, and no security
 * properties: it must never be mistaken for an actual sandbox.
 */
export async function startFakeWorkerServer(options: FakeWorkerServerOptions = {}): Promise<FakeWorkerServer> {
  const requests: RecordedRequest[] = [];
  const runtimes = new Map<string, FakeRuntime>();
  let runtimeCounter = 0;
  let commandCounter = 0;

  function appendRuntimeEvent(runtime: FakeRuntime, event: Omit<RuntimeEvent, "seq">): void {
    const seq = runtime.events.length + 1;
    runtime.events.push({ ...event, seq });
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://internal.invalid");
      const path = url.pathname;

      if (options.hangOnPath?.(path)) {
        return; // never respond, to simulate a hung connection
      }

      if (options.hangAfterHeadersOnPath?.(path)) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.flushHeaders();
        return; // headers sent, body deliberately never finishes
      }

      const rawBody = await readRequestBody(request);
      let parsedBody: unknown;
      if (rawBody.length > 0) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = rawBody;
        }
      }

      requests.push({
        method,
        path,
        headers: { ...request.headers },
        body: parsedBody,
      });

      if (options.responseDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.responseDelayMs));
      }

      const failure = options.failOn?.(method, path);
      if (failure) {
        response.writeHead(failure.status, { "Content-Type": "text/plain" });
        response.end(failure.body);
        return;
      }

      const redirect = options.redirectOnPath?.(method, path);
      if (redirect) {
        response.writeHead(redirect.status, { Location: redirect.location });
        response.end();
        return;
      }

      const oversizedBytes = options.oversizedBodyOnPath?.(path);
      if (oversizedBytes !== undefined) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(`"${"x".repeat(oversizedBytes)}"`);
        return;
      }

      const overrideBody = options.overrideResponseBodyOnPath?.(method, path);
      if (overrideBody !== undefined) {
        sendJson(response, 200, overrideBody);
        return;
      }

      // POST /internal/runtime/v1/runtimes
      if (method === "POST" && path === "/internal/runtime/v1/runtimes") {
        runtimeCounter += 1;
        const runtimeId = `${options.runtimeIdPrefix ?? "runtime"}-${runtimeCounter}`;
        const body = parsedBody as {
          sessionId: string;
          projectId: string;
          seed?: { files?: Array<{ path: string; content: string }> };
        };
        const runtime: FakeRuntime = {
          runtimeId,
          sessionId: body.sessionId,
          projectId: body.projectId,
          files: new Map((body.seed?.files ?? []).map((file) => [file.path, file.content])),
          commands: new Map(),
          events: [],
          createBody: parsedBody,
        };
        runtimes.set(runtimeId, runtime);
        sendJson(response, 201, {
          runtimeId,
          sessionId: options.respondWithSessionId ?? body.sessionId,
          status: "ready",
        });
        return;
      }

      const runtimeMatch = /^\/internal\/runtime\/v1\/runtimes\/([^/]+)(\/.*)?$/.exec(path);
      if (!runtimeMatch) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      const runtimeId = runtimeMatch[1]!;
      const subpath = runtimeMatch[2] ?? "";
      const runtime = runtimes.get(runtimeId);
      if (!runtime) {
        sendJson(response, 404, { error: "unknown_runtime" });
        return;
      }

      if (method === "DELETE" && subpath === "") {
        runtimes.delete(runtimeId);
        response.writeHead(204);
        response.end();
        return;
      }

      if (subpath === "/files") {
        const filePath = url.searchParams.get("path") ?? "";
        if (method === "GET") {
          if (!runtime.files.has(filePath)) {
            sendJson(response, 404, { error: "file_not_found" });
            return;
          }
          sendJson(response, 200, { content: runtime.files.get(filePath) });
          return;
        }
        if (method === "PUT") {
          const body = parsedBody as { path: string; content: string };
          runtime.files.set(body.path, body.content);
          appendRuntimeEvent(runtime, { type: "file.changed", path: body.path, changeType: "write" });
          sendJson(response, 200, { ok: true });
          return;
        }
        if (method === "PATCH") {
          const body = parsedBody as { path: string; patch: string };
          const current = runtime.files.get(body.path) ?? "";
          runtime.files.set(body.path, `${current}\n${body.patch}`.trim());
          appendRuntimeEvent(runtime, { type: "file.changed", path: body.path, changeType: "patch" });
          sendJson(response, 200, { ok: true });
          return;
        }
        if (method === "DELETE") {
          runtime.files.delete(filePath);
          appendRuntimeEvent(runtime, { type: "file.changed", path: filePath, changeType: "delete" });
          sendJson(response, 200, { ok: true });
          return;
        }
      }

      if (subpath === "/files/list" && method === "GET") {
        const root = url.searchParams.get("root") ?? "";
        const files = [...runtime.files.keys()].filter((path) => path.startsWith(root)).sort();
        sendJson(response, 200, { files });
        return;
      }

      if (subpath === "/files/snapshot" && method === "GET") {
        const files = [...runtime.files.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([path, content]) => ({ path, content }));
        sendJson(response, 200, { files });
        return;
      }

      if (subpath === "/commands" && method === "POST") {
        commandCounter += 1;
        const commandId = `command-${commandCounter}`;
        const body = parsedBody as { argv: string[] };
        const hang = body.argv.includes("RUNTIME_TEST_HANG");
        const shouldFail = body.argv[0] === "fail";
        const immediateExit = body.argv.includes("RUNTIME_TEST_IMMEDIATE_EXIT");
        const command: FakeCommand = {
          argv: body.argv,
          status: "running",
          events: [{ seq: 1, type: "output", chunk: `$ ${body.argv.join(" ")}\n` }],
          hang,
        };
        runtime.commands.set(commandId, command);
        if (immediateExit) {
          command.exitCode = 3;
          command.status = "exited";
          command.events.push({ seq: command.events.length + 1, type: "exit", code: command.exitCode });
        } else if (!hang) {
          setTimeout(() => {
            if (command.status !== "running") {
              return;
            }
            command.events.push({
              seq: command.events.length + 1,
              type: "output",
              chunk: "command completed\n",
            });
            command.exitCode = shouldFail ? 1 : 0;
            command.status = "exited";
            command.events.push({
              seq: command.events.length + 1,
              type: "exit",
              code: command.exitCode,
            });
          }, 10);
        }
        sendJson(response, 201, {
          commandId,
          status: command.status,
          ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
        });
        return;
      }

      const commandMatch = /^\/commands\/([^/]+)(\/.*)?$/.exec(subpath);
      if (commandMatch) {
        const commandId = commandMatch[1]!;
        const commandSubpath = commandMatch[2] ?? "";
        const command = runtime.commands.get(commandId);
        if (!command) {
          sendJson(response, 404, { error: "unknown_command" });
          return;
        }

        if (commandSubpath === "" && method === "GET") {
          sendJson(response, 200, {
            status: command.status,
            ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }),
          });
          return;
        }

        if (commandSubpath === "/events" && method === "GET") {
          const afterSeq = Number.parseInt(url.searchParams.get("afterSeq") ?? "0", 10);
          const events = command.events.filter((event) => event.seq > afterSeq);
          sendJson(response, 200, {
            events,
            nextSeq: command.events.at(-1)?.seq ?? afterSeq,
          });
          return;
        }

        if (commandSubpath === "/cancel" && method === "POST") {
          if (command.status === "running") {
            command.exitCode = -1;
            command.status = "exited";
            command.events.push({ seq: command.events.length + 1, type: "exit", code: -1 });
          }
          sendJson(response, 200, { status: command.status });
          return;
        }
      }

      if (subpath === "/previews" && method === "POST") {
        const body = parsedBody as { port?: number };
        const port = body.port ?? 4174;
        const origin = options.previewOrigin ?? "https://preview.example.test";
        const previewUrl = `${origin}/${runtimeId}/${port}`;
        appendRuntimeEvent(runtime, { type: "port.changed", port, url: previewUrl, status: "open" });
        sendJson(response, 200, { port, url: previewUrl, status: "open" });
        return;
      }

      if (subpath === "/events" && method === "GET") {
        const afterSeq = Number.parseInt(url.searchParams.get("afterSeq") ?? "0", 10);
        const events = runtime.events.filter((event) => event.seq > afterSeq);
        sendJson(response, 200, {
          events,
          nextSeq: runtime.events.at(-1)?.seq ?? afterSeq,
        });
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    runtimes,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Node's fetch (undici) pools keep-alive connections; without
        // forcing them closed here, server.close()'s callback would never
        // fire while a client keeps a socket open, hanging every test that
        // awaits it.
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
