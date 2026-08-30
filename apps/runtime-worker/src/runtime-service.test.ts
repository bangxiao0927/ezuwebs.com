import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTestRuntimeService } from "./test-support/build-test-runtime-service.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRuntime(runtimeService: Awaited<ReturnType<typeof buildTestRuntimeService>>["runtimeService"]) {
  return runtimeService.createRuntime({
    sessionId: `session-${Math.random()}`,
    projectId: "project-1",
    image: "ezu/sandbox:frontend",
    profile: "default",
  });
}

test("a command created against one runtime is not found through a different runtime's id", async () => {
  const { runtimeService } = await buildTestRuntimeService();
  const runtimeA = await createRuntime(runtimeService);
  const runtimeB = await createRuntime(runtimeService);

  const created = runtimeService.createCommand(runtimeA.runtimeId, {
    argv: ["node"],
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    policy: "frontend-build",
  });

  assert.equal(runtimeService.getCommandStatus(runtimeB.runtimeId, created.commandId), undefined);
  assert.throws(() => runtimeService.getCommandEvents(runtimeB.runtimeId, created.commandId, 0));
  await assert.rejects(() => runtimeService.cancelCommand(runtimeB.runtimeId, created.commandId));
});

test("createRuntime removes a partially created container and marks the runtime failed when startContainer throws", async () => {
  const { runtimeService, engine, registry } = await buildTestRuntimeService();
  const originalStart = engine.startContainer.bind(engine);
  engine.startContainer = async (containerId: string) => {
    await originalStart(containerId);
    throw new Error("boom");
  };

  await assert.rejects(() =>
    runtimeService.createRuntime({
      sessionId: "session-fail",
      projectId: "project-1",
      image: "ezu/sandbox:frontend",
      profile: "default",
    }),
  );

  const records = registry.list();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, "failed");
  assert.equal((await engine.listManagedContainers()).length, 0);

  const { events } = runtimeService.getEvents(records[0]!.runtimeId, 0);
  assert.ok(events.some((event) => event.type === "runtime.failed"));
});

test("markRuntimeFailed revokes preview tokens and resets the runtime's event log", async () => {
  const { runtimeService } = await buildTestRuntimeService();
  const created = await createRuntime(runtimeService);
  await runtimeService.writeFile(created.runtimeId, "index.html", "<h1>hi</h1>");
  const preview = runtimeService.createPreview(created.runtimeId, 4173);

  await runtimeService.markRuntimeFailed(created.runtimeId);

  assert.equal(runtimeService.resolvePreview(preview.token), undefined);
  const { events } = runtimeService.getEvents(created.runtimeId, 0);
  assert.deepEqual(events, []);
});

test("a command that hits its timeout terminates its container and marks the owning runtime failed", async () => {
  const { runtimeService, engine, registry } = await buildTestRuntimeService();
  const created = await createRuntime(runtimeService);
  engine.scriptedCommands.set("node", { exitCode: 0, delayMs: 200 });

  runtimeService.createCommand(created.runtimeId, {
    argv: ["node"],
    timeoutMs: 20,
    maxOutputBytes: 1024,
    policy: "frontend-build",
  });

  await wait(60);

  assert.equal(registry.get(created.runtimeId)?.status, "failed");
});
