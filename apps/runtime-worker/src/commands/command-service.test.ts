import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeDockerEngine } from "../docker/test-support/fake-docker-engine.js";
import { CommandPolicyError } from "./command-policy.js";
import { CommandNotFoundError, CommandService, CommandValidationError } from "./command-service.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const defaultLimits = { maxTimeoutMs: 60_000, maxOutputBytes: 1024 * 1024 };

function newService(engine: FakeDockerEngine, limits = defaultLimits): CommandService {
  return new CommandService(engine, limits);
}

test("create() runs an allowlisted command and records its output and exit as events", async () => {
  const engine = new FakeDockerEngine();
  engine.scriptedCommands.set("pnpm build", { exitCode: 0, stdout: "built\n" });
  const service = newService(engine);

  const created = service.create("container1", {
    argv: ["pnpm", "build"],
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    policy: "frontend-build",
  });
  assert.equal(created.status, "running");

  await wait(20);
  const status = service.getStatus("container1", created.commandId);
  assert.equal(status?.status, "exited");
  assert.equal(status?.exitCode, 0);

  const { events } = service.getEvents("container1", created.commandId, 0);
  const types = events.map((event) => event.type);
  assert.ok(types.includes("output"));
  assert.ok(types.includes("exit"));
});

test("create() rejects a command that fails its policy before ever reaching the engine", () => {
  const engine = new FakeDockerEngine();
  const service = newService(engine);

  assert.throws(
    () => service.create("container1", { argv: ["bash", "-c", "evil"], timeoutMs: 1000, maxOutputBytes: 1024, policy: "frontend-build" }),
    CommandPolicyError,
  );
});

test("output beyond maxOutputBytes is truncated and the command is stopped", async () => {
  const engine = new FakeDockerEngine();
  engine.scriptedCommands.set("pnpm build", { exitCode: 0, stdout: "x".repeat(100) });
  const service = newService(engine);

  const created = service.create("container1", {
    argv: ["pnpm", "build"],
    timeoutMs: 1000,
    maxOutputBytes: 10,
    policy: "frontend-build",
  });

  await wait(20);
  const status = service.getStatus("container1", created.commandId);
  assert.equal(status?.truncated, true);
  assert.deepEqual(engine.terminatedContainerIds, ["container1"]);
});

test("a command exceeding its timeout is reported as timedOut", async () => {
  const engine = new FakeDockerEngine();
  engine.scriptedCommands.set("pnpm build", { exitCode: 0, stdout: "ok", delayMs: 200 });
  const service = newService(engine);

  const created = service.create("container1", {
    argv: ["pnpm", "build"],
    timeoutMs: 20,
    maxOutputBytes: 1024,
    policy: "frontend-build",
  });

  await wait(60);
  const status = service.getStatus("container1", created.commandId);
  assert.equal(status?.timedOut, true);
  assert.deepEqual(engine.terminatedContainerIds, ["container1"]);
});

test("cancel() is idempotent and stops a running command", async () => {
  const engine = new FakeDockerEngine();
  engine.scriptedCommands.set("pnpm build", { exitCode: 0, stdout: "ok", delayMs: 200 });
  const service = newService(engine);

  const created = service.create("container1", {
    argv: ["pnpm", "build"],
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    policy: "frontend-build",
  });

  await service.cancel("container1", created.commandId);
  await service.cancel("container1", created.commandId);

  const status = service.getStatus("container1", created.commandId);
  assert.equal(status?.status, "exited");
  assert.deepEqual(engine.terminatedContainerIds, ["container1"]);
});

test("create() rejects a non-finite or non-positive timeoutMs or maxOutputBytes", () => {
  const engine = new FakeDockerEngine();
  const service = newService(engine);

  assert.throws(
    () => service.create("container1", { argv: ["node"], timeoutMs: Number.NaN, maxOutputBytes: 1024, policy: "frontend-build" }),
    CommandValidationError,
  );
  assert.throws(
    () => service.create("container1", { argv: ["node"], timeoutMs: 1000, maxOutputBytes: 0, policy: "frontend-build" }),
    CommandValidationError,
  );
  assert.throws(
    () => service.create("container1", { argv: ["node"], timeoutMs: -5, maxOutputBytes: 1024, policy: "frontend-build" }),
    CommandValidationError,
  );
});

test("create() clamps a timeoutMs or maxOutputBytes above the configured maximum", () => {
  const engine = new FakeDockerEngine();
  const service = newService(engine, { maxTimeoutMs: 1000, maxOutputBytes: 2000 });
  engine.scriptedCommands.set("node", { exitCode: 0 });

  service.create("container1", {
    argv: ["node"],
    timeoutMs: Number.MAX_SAFE_INTEGER,
    maxOutputBytes: Number.MAX_SAFE_INTEGER,
    policy: "frontend-build",
  });

  const execOptions = engine.lastExecOptions;
  assert.equal(execOptions?.timeoutMs, 1000);
  assert.equal(execOptions?.maxOutputBytes, 2000);
});

test("getStatus/getEvents/cancel treat a mismatched containerId as not found", async () => {
  const engine = new FakeDockerEngine();
  engine.scriptedCommands.set("pnpm build", { exitCode: 0, stdout: "built\n" });
  const service = newService(engine);

  const created = service.create("container1", {
    argv: ["pnpm", "build"],
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    policy: "frontend-build",
  });

  assert.equal(service.getStatus("container2", created.commandId), undefined);
  assert.throws(() => service.getEvents("container2", created.commandId, 0), CommandNotFoundError);
  await assert.rejects(() => service.cancel("container2", created.commandId), CommandNotFoundError);

  const events = service.getEvents("container1", created.commandId, 0);
  assert.ok(events);
});
