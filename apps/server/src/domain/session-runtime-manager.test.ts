import test from "node:test";
import assert from "node:assert/strict";

import { createSessionRuntimeManager } from "./session-runtime-manager.js";

test("withRuntime reuses the same runtime identity across calls for one session", async () => {
  const manager = createSessionRuntimeManager();
  const seedFiles = [{ path: "README.md", content: "# start" }];

  const first = await manager.withRuntime(
    "session-a",
    seedFiles,
    async (runtime) => runtime,
  );
  const second = await manager.withRuntime(
    "session-a",
    seedFiles,
    async (runtime) => runtime,
  );

  assert.equal(first.result, second.result, "the same runtime instance should be reused");
});

test("withRuntime seeds the runtime only on the first call for a session", async () => {
  const manager = createSessionRuntimeManager();
  const seedFiles = [{ path: "README.md", content: "# start" }];

  await manager.withRuntime("session-a", seedFiles, async (runtime) => {
    await runtime.writeFile("README.md", "# changed");
  });

  const { workspaceFiles } = await manager.withRuntime(
    "session-a",
    [{ path: "README.md", content: "# ignored, session already exists" }],
    async () => undefined,
  );

  const readme = workspaceFiles.find((file) => file.path === "README.md");
  assert.equal(readme?.content, "# changed", "later calls must reuse existing runtime state, not reseed");
});

test("withRuntime isolates runtimes between different sessions", async () => {
  const manager = createSessionRuntimeManager();

  await manager.withRuntime("session-a", [], async (runtime) => {
    await runtime.writeFile("shared.txt", "session-a content");
  });
  const { workspaceFiles } = await manager.withRuntime("session-b", [], async () => undefined);

  assert.equal(workspaceFiles.find((file) => file.path === "shared.txt"), undefined);
});

test("withRuntime serializes operations for the same session", async () => {
  const manager = createSessionRuntimeManager();
  const order: string[] = [];

  const slow = manager.withRuntime("session-a", [], async () => {
    order.push("slow-start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("slow-end");
  });
  const fast = manager.withRuntime("session-a", [], async () => {
    order.push("fast-start");
    order.push("fast-end");
  });

  await Promise.all([slow, fast]);

  assert.deepEqual(order, ["slow-start", "slow-end", "fast-start", "fast-end"]);
});

test("withRuntime runs operations for different sessions concurrently", async () => {
  const manager = createSessionRuntimeManager();
  const order: string[] = [];

  const slow = manager.withRuntime("session-a", [], async () => {
    order.push("a-start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("a-end");
  });
  const fast = manager.withRuntime("session-b", [], async () => {
    order.push("b-start");
    order.push("b-end");
  });

  await Promise.all([slow, fast]);

  assert.deepEqual(order, ["a-start", "b-start", "b-end", "a-end"]);
});

test("evictIdle drops sessions that have been idle past the ttl", async () => {
  let now = 0;
  const manager = createSessionRuntimeManager({ idleTtlMs: 1000, now: () => now });

  const first = await manager.withRuntime("session-a", [], async (runtime) => runtime);
  now += 2000;
  manager.evictIdle();

  const second = await manager.withRuntime("session-a", [], async (runtime) => runtime);
  assert.notEqual(first.result, second.result, "an evicted session must get a fresh runtime on its next use");
});

test("evictIdle never drops a session before its ttl has elapsed", async () => {
  let now = 0;
  const manager = createSessionRuntimeManager({ idleTtlMs: 1000, now: () => now });

  const first = await manager.withRuntime("session-a", [], async (runtime) => runtime);
  now += 500;
  manager.evictIdle();

  const second = await manager.withRuntime("session-a", [], async (runtime) => runtime);
  assert.equal(first.result, second.result);
});

test("evictIdle does not drop a session that is currently busy", async () => {
  let now = 0;
  const manager = createSessionRuntimeManager({ idleTtlMs: 1000, now: () => now });

  let releaseSlow: () => void = () => {};
  let resolveStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const slow = manager.withRuntime("session-a", [], async (runtime) => {
    now += 2000;
    resolveStarted();
    await new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    return runtime;
  });

  await started;
  manager.evictIdle();
  releaseSlow();
  const { result: runtimeDuringSlow } = await slow;

  const { result: runtimeAfter } = await manager.withRuntime("session-a", [], async (runtime) => runtime);
  assert.equal(runtimeDuringSlow, runtimeAfter, "a busy session must not be evicted mid-operation");
});

test("dispose removes a session's runtime once its in-flight operation settles", async () => {
  const manager = createSessionRuntimeManager();

  let releaseSlow: () => void = () => {};
  let resolveStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const slow = manager.withRuntime("session-a", [], async (runtime) => {
    resolveStarted();
    await new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    return runtime;
  });

  await started;
  const disposal = manager.dispose("session-a");
  releaseSlow();
  await slow;
  await disposal;

  const { result: runtimeAfterDispose } = await manager.withRuntime(
    "session-a",
    [{ path: "seed.txt", content: "fresh" }],
    async (runtime) => runtime,
  );
  const workspaceFiles = await runtimeAfterDispose.listFiles("");
  assert.deepEqual(workspaceFiles, ["seed.txt"], "dispose must clear stored runtime state, forcing a reseed");
});

test("disposeAll clears every session's runtime", async () => {
  const manager = createSessionRuntimeManager();

  await manager.withRuntime("session-a", [{ path: "a.txt", content: "a" }], async () => undefined);
  await manager.withRuntime("session-b", [{ path: "b.txt", content: "b" }], async () => undefined);

  await manager.disposeAll();

  const { workspaceFiles: filesA } = await manager.withRuntime("session-a", [], async () => undefined);
  const { workspaceFiles: filesB } = await manager.withRuntime("session-b", [], async () => undefined);

  assert.deepEqual(filesA, []);
  assert.deepEqual(filesB, []);
});

test("withRuntime rebuilds session state from persisted files after a manager restart", async () => {
  const persistedFiles = [{ path: "src/App.tsx", content: "export const App = 'v2';" }];

  // Simulates a fresh process: a new manager instance backed only by what a
  // session repository had persisted from the previous manager's snapshots.
  const restartedManager = createSessionRuntimeManager();

  const { result: content } = await restartedManager.withRuntime(
    "session-a",
    persistedFiles,
    async (runtime) => runtime.readFile("src/App.tsx"),
  );

  assert.equal(content, "export const App = 'v2';");
});

test("withRuntime snapshots the workspace after the operation runs", async () => {
  const manager = createSessionRuntimeManager();

  const { workspaceFiles } = await manager.withRuntime("session-a", [], async (runtime) => {
    await runtime.writeFile("src/index.ts", "export const value = 1;");
  });

  assert.deepEqual(workspaceFiles, [{ path: "src/index.ts", content: "export const value = 1;" }]);
});
