import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { FakeDockerEngine } from "./docker/test-support/fake-docker-engine.js";
import { RuntimeRegistry } from "./registry/runtime-registry.js";
import { startRuntimeWorker } from "./server.js";
import type { WorkerConfig } from "./config.js";

async function testConfig(overrides: Partial<WorkerConfig> = {}): Promise<WorkerConfig> {
  const dir = await mkdtemp(path.join(tmpdir(), "runtime-worker-server-test-"));
  return {
    host: "127.0.0.1",
    port: 0,
    apiToken: "test-token-".padEnd(32, "x"),
    root: dir,
    publicPreviewBaseUrl: "http://127.0.0.1:1",
    allowInsecureLoopback: true,
    allowedImages: ["img"],
    dockerBin: "/usr/bin/docker",
    requireRootless: true,
    limits: {
      maxRuntimes: 10,
      memoryBytes: 1024,
      cpus: 1,
      pidsLimit: 10,
      workspaceMaxFileBytes: 1024,
      workspaceMaxFileCount: 10,
      workspaceMaxTotalBytes: 4096,
      commandMaxOutputBytes: 1024,
      commandMaxTimeoutMs: 5000,
      runtimeTtlMs: 60_000,
      runtimeCreateTimeoutMs: 60_000,
      dockerOperationTimeoutMs: 30_000,
    },
    ...overrides,
  };
}

test("startRuntimeWorker fails closed when requireRootless is true and the engine reports not rootless", async () => {
  const engine = new FakeDockerEngine();
  engine.rootless = false;
  const config = await testConfig();

  await assert.rejects(() => startRuntimeWorker(config, engine));
});

test("shutdown() cancels running commands and disposes runtimes when configured to", async () => {
  const engine = new FakeDockerEngine();
  const config = await testConfig();
  const worker = await startRuntimeWorker(config, engine);

  const created = await worker.runtimeService.createRuntime({
    sessionId: "s1",
    projectId: "p1",
    image: "img",
    profile: "default",
  });

  await worker.shutdown({ disposeAllRuntimes: true });

  assert.throws(() => worker.runtimeService.requireRuntime(created.runtimeId));
});

test("startRuntimeWorker fails a 'creating' record left behind by a crashed process, freeing its session for retry", async () => {
  const base = await testConfig();
  const config: WorkerConfig = { ...base, limits: { ...base.limits, maxRuntimes: 1 } };

  const priorProcessRegistry = new RuntimeRegistry(path.join(config.root, "registry.json"), {
    maxRuntimes: config.limits.maxRuntimes,
  });
  await priorProcessRegistry.load();
  const stuck = await priorProcessRegistry.create({
    sessionId: "s1",
    projectId: "p1",
    image: "img",
    profile: "default",
  });

  const engine = new FakeDockerEngine();
  const worker = await startRuntimeWorker(config, engine);

  assert.equal(worker.runtimeService.requireRuntime(stuck.runtimeId).status, "failed");

  const retried = await worker.runtimeService.createRuntime({
    sessionId: "s1",
    projectId: "p1",
    image: "img",
    profile: "default",
  });
  assert.equal(retried.status, "ready");

  await worker.shutdown({ disposeAllRuntimes: true });
});
