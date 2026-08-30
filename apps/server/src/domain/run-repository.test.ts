import test from "node:test";
import assert from "node:assert/strict";

import {
  createMemoryRunRepository,
  RunNotFoundError,
  RunNotQueuedError,
  RunVersionConflictError,
} from "./run-repository.js";

test("create/get round-trips a run in the queued state", async () => {
  const repo = createMemoryRunRepository();
  const created = await repo.create({ id: "run-1", sessionId: "session-1", kind: "prompt", input: { text: "hi" } });

  assert.equal(created.status, "queued");
  assert.equal(created.cancelRequested, false);
  assert.equal(created.version, 1);
  assert.deepEqual(await repo.get("run-1"), created);
});

test("claim transitions a queued run to running and rejects claiming it twice", async () => {
  const repo = createMemoryRunRepository();
  await repo.create({ id: "run-1", sessionId: "session-1", kind: "prompt", input: {} });

  const claimed = await repo.claim("run-1");
  assert.equal(claimed.status, "running");
  assert.ok(claimed.startedAt);

  await assert.rejects(repo.claim("run-1"), RunNotQueuedError);
});

test("appendEvent allocates strictly increasing, non-duplicated sequence numbers under concurrent appends", async () => {
  const repo = createMemoryRunRepository();
  await repo.create({ id: "run-1", sessionId: "session-1", kind: "prompt", input: {} });

  const results = await Promise.all(
    Array.from({ length: 20 }, (_v, index) =>
      repo.appendEvent("run-1", { type: "message.delta", messageId: "m", text: String(index) }),
    ),
  );

  const seqs = results.map((result) => result.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 20 }, (_v, index) => index + 1));
});

test("listEventsAfter returns only events with a higher sequence number, in order", async () => {
  const repo = createMemoryRunRepository();
  await repo.create({ id: "run-1", sessionId: "session-1", kind: "prompt", input: {} });
  await repo.appendEvent("run-1", { type: "message.delta", messageId: "m", text: "a" });
  await repo.appendEvent("run-1", { type: "message.delta", messageId: "m", text: "b" });
  await repo.appendEvent("run-1", { type: "message.delta", messageId: "m", text: "c" });

  const events = await repo.listEventsAfter("run-1", 1);
  assert.deepEqual(
    events.map((entry) => entry.seq),
    [2, 3],
  );
});

test("getLastEventSeq returns the highest seq for a run, or 0 when it has no events", async () => {
  const repo = createMemoryRunRepository();
  await repo.create({ id: "run-1", sessionId: "session-1", kind: "prompt", input: {} });
  assert.equal(await repo.getLastEventSeq("run-1"), 0);

  await repo.appendEvent("run-1", { type: "message.delta", messageId: "m", text: "a" });
  await repo.appendEvent("run-1", { type: "message.delta", messageId: "m", text: "b" });

  assert.equal(await repo.getLastEventSeq("run-1"), 2);
});

test("complete/fail/cancel require the caller's expected version and reject a stale one", async () => {
  const repo = createMemoryRunRepository();
  const created = await repo.create({ id: "run-1", sessionId: "session-1", kind: "prompt", input: {} });
  await repo.claim("run-1");

  const completed = await repo.complete("run-1", 2);
  assert.equal(completed.status, "completed");
  assert.ok(completed.completedAt);

  await assert.rejects(repo.complete("run-1", created.version), RunVersionConflictError);
});

test("fail records an error message on the terminal record", async () => {
  const repo = createMemoryRunRepository();
  await repo.create({ id: "run-1", sessionId: "session-1", kind: "prompt", input: {} });
  const claimed = await repo.claim("run-1");

  const failed = await repo.fail("run-1", claimed.version, "boom");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "boom");
});

test("requestCancel is idempotent and does not resurrect a terminal run", async () => {
  const repo = createMemoryRunRepository();
  await repo.create({ id: "run-1", sessionId: "session-1", kind: "prompt", input: {} });
  const claimed = await repo.claim("run-1");

  const firstFlag = await repo.requestCancel("run-1");
  const secondFlag = await repo.requestCancel("run-1");
  assert.equal(firstFlag.cancelRequested, true);
  assert.equal(secondFlag.version, firstFlag.version);

  const cancelled = await repo.cancel("run-1", firstFlag.version);
  assert.equal(cancelled.status, "cancelled");

  const afterTerminal = await repo.requestCancel("run-1");
  assert.equal(afterTerminal.status, "cancelled");
  assert.equal(afterTerminal.version, cancelled.version);
});

test("listRunningRuns and listQueuedRuns only return runs in that status", async () => {
  const repo = createMemoryRunRepository();
  await repo.create({ id: "run-queued", sessionId: "session-1", kind: "prompt", input: {} });
  await repo.create({ id: "run-running", sessionId: "session-1", kind: "prompt", input: {} });
  await repo.claim("run-running");

  assert.deepEqual((await repo.listQueuedRuns()).map((run) => run.id), ["run-queued"]);
  assert.deepEqual((await repo.listRunningRuns()).map((run) => run.id), ["run-running"]);
});

test("operations on an unknown run throw RunNotFoundError", async () => {
  const repo = createMemoryRunRepository();
  await assert.rejects(repo.claim("missing"), RunNotFoundError);
  await assert.rejects(repo.complete("missing", 1), RunNotFoundError);
});
