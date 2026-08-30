import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { type EzuDb } from "@ezu/db";

import { createSqliteRunRepository } from "./sqlite-run-repository.js";
import { type RunRepository, RunNotQueuedError, RunVersionConflictError } from "./run-repository.js";

async function openTestRepository(t: {
  after(fn: () => Promise<void> | void): void;
  skip(message: string): void;
}): Promise<{ repository: RunRepository; db: EzuDb } | undefined> {
  const directory = await mkdtemp(path.join(tmpdir(), "ezu-runs-sqlite-"));
  const databaseUrl = path.join(directory, "runs.db");

  const { openDatabase, createSessionRow } = await import("@ezu/db");
  let db;
  try {
    db = openDatabase({ databaseUrl, runMigrations: true });
  } catch (cause) {
    t.after(() => rm(directory, { recursive: true, force: true }));
    if (cause instanceof Error && /bindings file/.test(cause.message)) {
      t.skip("better-sqlite3 native binding is unavailable in this environment");
      return undefined;
    }
    throw cause;
  }
  t.after(() => {
    db.$client.close();
    return rm(directory, { recursive: true, force: true });
  });

  createSessionRow(db, {
    id: "session-1",
    definitionId: "club-promo",
    projectId: "project-1",
    bootstrapJson: JSON.stringify({ config: { projectName: "Test" } }),
    webEditorJson: JSON.stringify({ blocks: [], properties: [] }),
    events: [],
    workspaceFiles: [],
  });

  return { repository: createSqliteRunRepository({ db }), db };
}

test("createSqliteRunRepository persists a run and round-trips it through get", async (t) => {
  const context = await openTestRepository(t);
  if (!context) return;
  const { repository } = context;

  const created = await repository.create({
    id: "run-1",
    sessionId: "session-1",
    userId: "user-1",
    kind: "prompt",
    input: { text: "hello" },
  });

  assert.equal(created.status, "queued");
  const fetched = await repository.get("run-1");
  assert.deepEqual(fetched, created);
});

test("createSqliteRunRepository claim/complete follow the same CAS rules as the memory repository", async (t) => {
  const context = await openTestRepository(t);
  if (!context) return;
  const { repository } = context;
  await repository.create({ id: "run-1", sessionId: "session-1", kind: "prompt", input: {} });

  const claimed = await repository.claim("run-1");
  assert.equal(claimed.status, "running");
  await assert.rejects(repository.claim("run-1"), RunNotQueuedError);

  const completed = await repository.complete("run-1", claimed.version);
  assert.equal(completed.status, "completed");
  await assert.rejects(repository.complete("run-1", claimed.version), RunVersionConflictError);
});

test("createSqliteRunRepository appendEvent/listEventsAfter persist events with increasing sequence numbers", async (t) => {
  const context = await openTestRepository(t);
  if (!context) return;
  const { repository } = context;
  await repository.create({ id: "run-1", sessionId: "session-1", kind: "prompt", input: {} });

  await repository.appendEvent("run-1", { type: "message.delta", messageId: "m", text: "a" });
  await repository.appendEvent("run-1", { type: "message.delta", messageId: "m", text: "b" });

  const events = await repository.listEventsAfter("run-1", 0);
  assert.deepEqual(
    events.map((entry) => entry.seq),
    [1, 2],
  );
});

test("createSqliteRunRepository requestCancel and listRunningRuns/listQueuedRuns", async (t) => {
  const context = await openTestRepository(t);
  if (!context) return;
  const { repository } = context;
  await repository.create({ id: "run-queued", sessionId: "session-1", kind: "prompt", input: {} });
  await repository.create({ id: "run-running", sessionId: "session-1", kind: "prompt", input: {} });
  await repository.claim("run-running");

  const cancelFlagged = await repository.requestCancel("run-running");
  assert.equal(cancelFlagged.cancelRequested, true);

  assert.deepEqual((await repository.listQueuedRuns()).map((run) => run.id), ["run-queued"]);
  assert.deepEqual((await repository.listRunningRuns()).map((run) => run.id), ["run-running"]);
});
