import assert from "node:assert/strict";
import test from "node:test";

import {
  RemoteRuntimeError,
  RemoteRuntimePreviewRejectedError,
  RemoteRuntimeSessionMismatchError,
  RemoteRuntimeValidationError,
} from "./errors.js";
import {
  createRemoteRuntimeAdapter,
  RUNTIME_POLICY_TIMEOUT_EXIT_CODE,
  RUNTIME_PROTOCOL_ERROR_EXIT_CODE,
} from "./remote-runtime-adapter.js";
import { startFakeWorkerServer, type FakeWorkerServer } from "./test-support/fake-worker-server.js";

function baseConfig(worker: FakeWorkerServer, overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: worker.url,
    apiToken: "secret-token",
    sessionId: "session-a",
    projectId: "project-a",
    image: "node20",
    profile: "default",
    allowInsecureLoopback: true,
    pollIntervalMs: 10,
    ...overrides,
  };
}

let worker: FakeWorkerServer;

test.beforeEach(async () => {
  worker = await startFakeWorkerServer();
});

test.afterEach(async () => {
  await worker.close();
});

test("lazily creates the runtime on first use, seeding it, and only once across multiple operations", async () => {
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker), [{ path: "README.md", content: "# start" }]);

  const first = await adapter.readFile("README.md");
  await adapter.listFiles("");

  const createCalls = worker.requests.filter(
    (request) => request.method === "POST" && request.path === "/internal/runtime/v1/runtimes",
  );
  assert.equal(createCalls.length, 1, "the runtime must be created exactly once");
  assert.equal(first, "# start");
  const created = [...worker.runtimes.values()][0]!;
  assert.equal(created.sessionId, "session-a");
  assert.equal(created.projectId, "project-a");
});

test("supports the full file CRUD contract against the worker", async () => {
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));

  await adapter.writeFile("src/index.ts", "export const value = 1;");
  assert.equal(await adapter.readFile("src/index.ts"), "export const value = 1;");

  await adapter.patchFile("src/index.ts", "// patched");
  assert.equal(await adapter.readFile("src/index.ts"), "export const value = 1;\n// patched");

  assert.deepEqual(await adapter.listFiles(""), ["src/index.ts"]);

  await adapter.deleteFile("src/index.ts");
  assert.deepEqual(await adapter.listFiles(""), []);
});

test("rejects a malicious path before any request reaches the worker", async () => {
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));

  await assert.rejects(adapter.readFile("../../etc/passwd"), RemoteRuntimeValidationError);
  assert.equal(worker.requests.length, 0, "no request should have been sent for an invalid path");
});

test("throws a typed error when the worker binds the runtime to a different sessionId", async () => {
  await worker.close();
  worker = await startFakeWorkerServer({ respondWithSessionId: "session-other" });
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));

  await assert.rejects(adapter.listFiles(""), RemoteRuntimeSessionMismatchError);
});

test("runCommand streams output and reports the exit code", async () => {
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));
  const chunks: string[] = [];

  const process = await adapter.runCommand("pnpm build");
  process.onOutput((chunk) => chunks.push(chunk));
  const exitCode = await new Promise<number>((resolve) => process.onExit(resolve));

  assert.equal(exitCode, 0);
  assert.ok(chunks.some((chunk) => chunk.includes("pnpm build")));
  assert.ok(chunks.some((chunk) => chunk.includes("command completed")));
});

test("runCommand reports a non-zero exit code for a failing command", async () => {
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));

  const process = await adapter.runCommand("fail now");
  const exitCode = await new Promise<number>((resolve) => process.onExit(resolve));

  assert.equal(exitCode, 1);
});

test("runCommand.kill is idempotent and stops a hanging command", async () => {
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));

  const process = await adapter.runCommand("echo RUNTIME_TEST_HANG");
  let exited = false;
  process.onExit(() => {
    exited = true;
  });

  await process.kill();
  await process.kill();

  assert.equal(exited, false, "a worker-side cancel does not itself emit a client-side exit event in this contract");
  const cancelCalls = worker.requests.filter((request) => request.path.endsWith("/cancel"));
  assert.equal(cancelCalls.length, 1, "a second kill() must not send a second cancel request");
});

test("rejects a command containing shell metacharacters before any request reaches the worker", async () => {
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));

  await assert.rejects(adapter.runCommand("pnpm build; rm -rf /"), RemoteRuntimeValidationError);
  assert.equal(worker.requests.length, 0);
});

test("watchFiles and watchPorts share one poll loop and stop polling once unsubscribed", async () => {
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));
  const fileEvents: Array<{ path: string; type: string }> = [];

  const unsubscribe = await adapter.watchFiles((event) => fileEvents.push(event));
  await adapter.writeFile("a.txt", "content");

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(fileEvents, [{ path: "a.txt", type: "write" }]);

  unsubscribe();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const requestCountAfterUnsubscribe = worker.requests.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    worker.requests.length,
    requestCountAfterUnsubscribe,
    "no further polling requests should be sent once every watcher has unsubscribed",
  );
});

test("watchPorts observes a preview becoming open", async () => {
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));
  const portEvents: Array<{ port: number; url: string; status: string }> = [];

  const unsubscribe = await adapter.watchPorts((event) => portEvents.push(event));
  await adapter.openPreview(4174);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(portEvents, [
    { port: 4174, url: "https://preview.example.test/runtime-1/4174", status: "open" },
  ]);
  unsubscribe();
});

test("openPreview accepts an https preview URL matching the configured previewBaseUrl", async () => {
  await worker.close();
  worker = await startFakeWorkerServer({ previewOrigin: "https://preview.example.test" });
  const adapter = createRemoteRuntimeAdapter(
    baseConfig(worker, { previewBaseUrl: "https://preview.example.test" }),
  );
  const preview = await adapter.openPreview(4174);
  assert.equal(preview.status, "open");
  assert.ok(preview.url.startsWith("https://preview.example.test/"));
});

test("openPreview rejects a preview URL whose origin does not match previewBaseUrl", async () => {
  await worker.close();
  worker = await startFakeWorkerServer({ previewOrigin: "https://untrusted.example.test" });
  const adapter = createRemoteRuntimeAdapter(
    baseConfig(worker, { previewBaseUrl: "https://preview.example.test" }),
  );

  await assert.rejects(adapter.openPreview(4174), RemoteRuntimePreviewRejectedError);
});

test("dispose deletes the runtime and rejects further use", async () => {
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));
  await adapter.listFiles("");
  const runtimeId = [...worker.runtimes.keys()][0]!;

  await adapter.dispose!();

  assert.equal(worker.runtimes.has(runtimeId), false);
  const deleteCalls = worker.requests.filter(
    (request) => request.method === "DELETE" && request.path === `/internal/runtime/v1/runtimes/${runtimeId}`,
  );
  assert.equal(deleteCalls.length, 1);
  await assert.rejects(adapter.listFiles(""), RemoteRuntimeError);
});

test("dispose without ever creating a runtime does not call the worker", async () => {
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));
  await adapter.dispose!();
  assert.equal(worker.requests.length, 0);
});

test("dispose kills every live process before deleting the runtime and leaves no polling timer running", async () => {
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));
  await adapter.runCommand("echo RUNTIME_TEST_HANG");
  const runtimeId = [...worker.runtimes.keys()][0]!;

  await adapter.dispose!();

  const cancelCalls = worker.requests.filter((request) => request.path.endsWith("/cancel"));
  assert.equal(cancelCalls.length, 1, "dispose must best-effort cancel every live process");
  assert.equal(worker.runtimes.has(runtimeId), false);

  const requestCountAfterDispose = worker.requests.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(
    requestCountAfterDispose,
    worker.requests.length,
    "no further requests should be sent once every process and the event bus have stopped",
  );
});

test("dispose waits for an in-flight runtime creation before deleting it", async () => {
  await worker.close();
  worker = await startFakeWorkerServer({ responseDelayMs: 30 });
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));

  const listFilesPromise = adapter.listFiles("");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await adapter.dispose!();
  // The in-flight listFiles() may now race dispose's DELETE for the same
  // runtime and lose; only the runtime's cleanup is under test here.
  await listFilesPromise.catch(() => undefined);

  assert.equal(worker.runtimes.size, 0, "the runtime created while dispose was waiting must still be deleted");
});

test("dispose is safe when an in-flight runtime creation ultimately fails", async () => {
  await worker.close();
  worker = await startFakeWorkerServer({
    responseDelayMs: 30,
    failOn: (method, path) =>
      method === "POST" && path === "/internal/runtime/v1/runtimes" ? { status: 500, body: "boom" } : undefined,
  });
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));

  const listFilesPromise = adapter.listFiles("");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await adapter.dispose!();
  await assert.rejects(listFilesPromise);

  assert.equal(worker.requests.filter((request) => request.method === "DELETE").length, 0);
});

test("concurrent dispose calls are safe and delete the runtime exactly once", async () => {
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));
  await adapter.listFiles("");
  const runtimeId = [...worker.runtimes.keys()][0]!;

  await Promise.all([adapter.dispose!(), adapter.dispose!()]);

  assert.equal(worker.runtimes.has(runtimeId), false);
  const deleteCalls = worker.requests.filter(
    (request) => request.method === "DELETE" && request.path === `/internal/runtime/v1/runtimes/${runtimeId}`,
  );
  assert.equal(deleteCalls.length, 1);
});

test("runCommand force-stops with a protocol-error exit code when the events endpoint returns a malformed response", async () => {
  await worker.close();
  worker = await startFakeWorkerServer({
    overrideResponseBodyOnPath: (method, path) =>
      method === "GET" && path.includes("/commands/") && path.endsWith("/events") ? { events: "not-an-array" } : undefined,
  });
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));

  const process = await adapter.runCommand("pnpm build");
  const exitCode = await new Promise<number>((resolve) => process.onExit(resolve));

  assert.equal(exitCode, RUNTIME_PROTOCOL_ERROR_EXIT_CODE);
});

test("runCommand eventually force-stops with a policy-timeout exit code when the events endpoint keeps failing with 500", async () => {
  await worker.close();
  worker = await startFakeWorkerServer({
    failOn: (method, path) => (method === "GET" && path.endsWith("/events") ? { status: 500, body: "boom" } : undefined),
  });
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker, { commandTimeoutMs: 50 }));

  const process = await adapter.runCommand("pnpm build");
  const exitCode = await new Promise<number>((resolve) => process.onExit(resolve));

  assert.equal(exitCode, RUNTIME_POLICY_TIMEOUT_EXIT_CODE);
});

test("watchPorts drops a port.changed event whose URL fails preview validation and stops the shared poll loop", async () => {
  const adapter = createRemoteRuntimeAdapter(
    baseConfig(worker, { previewBaseUrl: "https://preview.example.test" }),
  );
  const portEvents: Array<{ port: number; url: string; status: string }> = [];
  await adapter.watchPorts((event) => portEvents.push(event));
  await adapter.listFiles("");
  const runtimeId = [...worker.runtimes.keys()][0]!;
  const runtime = worker.runtimes.get(runtimeId)!;
  runtime.events.push({
    seq: runtime.events.length + 1,
    type: "port.changed",
    port: 4174,
    url: "https://attacker.example.test/steal",
    status: "open",
  });

  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(portEvents, []);
});

test("watchFiles/watchPorts stop polling once the runtime-wide events endpoint returns a malformed response", async () => {
  await worker.close();
  worker = await startFakeWorkerServer({
    overrideResponseBodyOnPath: (method, path) =>
      method === "GET" && !path.includes("/commands/") && path.endsWith("/events") ? { events: "not-an-array" } : undefined,
  });
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));

  await adapter.watchFiles(() => {});
  const requestCountAfterFirstPoll = worker.requests.length;
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.ok(
    worker.requests.length <= requestCountAfterFirstPoll + 1,
    "the shared poll loop must stop rather than keep retrying a malformed response forever",
  );
});

test("two adapters for different sessions never see each other's files", async () => {
  const adapterA = createRemoteRuntimeAdapter(baseConfig(worker, { sessionId: "session-a" }));
  const adapterB = createRemoteRuntimeAdapter(baseConfig(worker, { sessionId: "session-b" }));

  await adapterA.writeFile("shared.txt", "session-a content");
  await adapterB.writeFile("shared.txt", "session-b content");

  assert.equal(await adapterA.readFile("shared.txt"), "session-a content");
  assert.equal(await adapterB.readFile("shared.txt"), "session-b content");
});

test("onExit called after the process has already exited still notifies the late listener", async () => {
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));

  const process = await adapter.runCommand("pnpm build");
  const firstExitCode = await new Promise<number>((resolve) => process.onExit(resolve));
  assert.equal(firstExitCode, 0);

  const lateExitCode = await new Promise<number>((resolve) => process.onExit(resolve));
  assert.equal(lateExitCode, 0);
});

test("runCommand settles the process immediately using the exit code in the worker's create response", async () => {
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));

  const process = await adapter.runCommand("echo RUNTIME_TEST_IMMEDIATE_EXIT");
  const exitCode = await new Promise<number>((resolve) => process.onExit(resolve));

  assert.equal(exitCode, 3);
  const eventCalls = worker.requests.filter((request) => request.path.endsWith("/events"));
  assert.equal(eventCalls.length, 0, "an already-exited command must not need to poll for its own events");
});

test("snapshotFiles fetches every file from the worker in a single request", async () => {
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker));
  await adapter.writeFile("a.txt", "content-a");
  await adapter.writeFile("b.txt", "content-b");

  const requestCountBefore = worker.requests.length;
  const files = await adapter.snapshotFiles!();

  assert.deepEqual(files, [
    { path: "a.txt", content: "content-a" },
    { path: "b.txt", content: "content-b" },
  ]);
  const snapshotCalls = worker.requests.slice(requestCountBefore).filter((request) => request.path.endsWith("/files/snapshot"));
  assert.equal(snapshotCalls.length, 1, "the snapshot must be fetched in exactly one request");
});

test("snapshotFiles rejects a worker response exceeding the configured file count limit", async () => {
  await worker.close();
  worker = await startFakeWorkerServer({
    overrideResponseBodyOnPath: (method, path) =>
      method === "GET" && path.endsWith("/files/snapshot")
        ? { files: [{ path: "a.txt", content: "a" }, { path: "b.txt", content: "b" }] }
        : undefined,
  });
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker, { limits: { maxFileCount: 1 } }));

  await assert.rejects(adapter.snapshotFiles!(), RemoteRuntimeValidationError);
});

test("a poll generation guard prevents a stale in-flight poll from doubling the shared poll loop after an unsubscribe/resubscribe race", async () => {
  await worker.close();
  worker = await startFakeWorkerServer({ responseDelayMs: 40 });
  const adapter = createRemoteRuntimeAdapter(baseConfig(worker, { pollIntervalMs: 15 }));
  await adapter.listFiles(""); // create the runtime outside the timing-sensitive window below

  const eventsA: Array<{ path: string; type: string }> = [];
  const eventsB: Array<{ path: string; type: string }> = [];

  const unsubscribeA = await adapter.watchFiles((event) => eventsA.push(event));
  await new Promise((resolve) => setTimeout(resolve, 10)); // let the first poll's request start

  unsubscribeA();
  const unsubscribeB = await adapter.watchFiles((event) => eventsB.push(event));
  await adapter.writeFile("a.txt", "content");

  await new Promise((resolve) => setTimeout(resolve, 300));
  unsubscribeB();

  assert.deepEqual(eventsA, []);
  assert.deepEqual(
    eventsB,
    [{ path: "a.txt", type: "write" }],
    "a stale poll chain from before the resubscribe must never dispatch a second, duplicate event",
  );
});
