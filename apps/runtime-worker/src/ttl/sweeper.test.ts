import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTestRuntimeService } from "../test-support/build-test-runtime-service.js";
import { RuntimeSweeper } from "./sweeper.js";

test("sweepExpired() stops and deletes a runtime past its expiresAt, and removes it from the registry", async () => {
  const { runtimeService, registry, engine } = await buildTestRuntimeService();
  const created = await runtimeService.createRuntime({
    sessionId: "s1",
    projectId: "p1",
    image: "ezu/sandbox:frontend",
    profile: "default",
  });
  await registry.update(created.runtimeId, { expiresAt: new Date(Date.now() - 1000).toISOString() });

  const sweeper = new RuntimeSweeper(runtimeService);
  await sweeper.sweepExpired();

  assert.equal(registry.get(created.runtimeId), undefined);
  assert.equal((await engine.listManagedContainers()).length, 0);
});

test("sweepExpired() leaves a runtime with a future expiresAt untouched", async () => {
  const { runtimeService, registry } = await buildTestRuntimeService();
  const created = await runtimeService.createRuntime({
    sessionId: "s1",
    projectId: "p1",
    image: "ezu/sandbox:frontend",
    profile: "default",
  });
  await registry.update(created.runtimeId, { expiresAt: new Date(Date.now() + 100000).toISOString() });

  const sweeper = new RuntimeSweeper(runtimeService);
  await sweeper.sweepExpired();

  assert.ok(registry.get(created.runtimeId));
});

test("reconcileOrphans() removes a managed container that has no matching registry record", async () => {
  const { runtimeService, engine } = await buildTestRuntimeService();
  await engine.createContainer({
    runtimeId: "rt-unknown",
    image: "img",
    labels: {},
    memoryBytes: 1,
    cpus: 1,
    pidsLimit: 1,
    workspaceExec: false,
  });

  const sweeper = new RuntimeSweeper(runtimeService);
  await sweeper.reconcileOrphans();

  assert.equal((await engine.listManagedContainers()).length, 0);
});

test("reconcileOrphans() marks a registry record failed when its container has disappeared", async () => {
  const { runtimeService, registry } = await buildTestRuntimeService();
  const created = await runtimeService.createRuntime({
    sessionId: "s1",
    projectId: "p1",
    image: "ezu/sandbox:frontend",
    profile: "default",
  });
  await registry.update(created.runtimeId, { containerId: "gone" });

  const sweeper = new RuntimeSweeper(runtimeService);
  await sweeper.reconcileOrphans();

  assert.equal(registry.get(created.runtimeId)?.status, "failed");
});

test("reconcileOrphans() marking a runtime failed also revokes its preview tokens", async () => {
  const { runtimeService, registry } = await buildTestRuntimeService();
  const created = await runtimeService.createRuntime({
    sessionId: "s1",
    projectId: "p1",
    image: "ezu/sandbox:frontend",
    profile: "default",
  });
  await runtimeService.writeFile(created.runtimeId, "index.html", "<h1>hi</h1>");
  const preview = runtimeService.createPreview(created.runtimeId, 4173);
  await registry.update(created.runtimeId, { containerId: "gone" });

  const sweeper = new RuntimeSweeper(runtimeService);
  await sweeper.reconcileOrphans();

  assert.equal(runtimeService.resolvePreview(preview.token), undefined);
});
