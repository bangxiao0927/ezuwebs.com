import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { openDatabase } from "./client.js";
import { createSessionRow } from "./sessions.js";
import {
  appendRunEventRow,
  createRunRow,
  getMaxRunEventSeq,
  getRunRow,
  listRunEventRowsAfter,
  listRunsBySession,
  updateRunRow,
  RunAlreadyExistsError,
  RunRowNotFoundError,
  RunVersionConflictError,
} from "./runs.js";

async function openTempDatabase(t: { after(fn: () => Promise<void> | void): void }) {
  const directory = await mkdtemp(path.join(tmpdir(), "ezu-runs-db-"));
  const databaseUrl = path.join(directory, "runs.db");
  let db;
  try {
    db = openDatabase({ databaseUrl, runMigrations: true });
  } catch (cause) {
    t.after(() => rm(directory, { recursive: true, force: true }));
    if (cause instanceof Error && /bindings file/.test(cause.message)) {
      return undefined;
    }
    throw cause;
  }
  t.after(() => {
    db.$client.close();
    return rm(directory, { recursive: true, force: true });
  });
  return db;
}

function seedSession(db: NonNullable<Awaited<ReturnType<typeof openTempDatabase>>>, id: string): void {
  createSessionRow(db, {
    id,
    definitionId: "club-promo",
    projectId: "project-1",
    bootstrapJson: JSON.stringify({ config: { projectName: "Test" } }),
    webEditorJson: JSON.stringify({ blocks: [], properties: [] }),
    events: [],
    workspaceFiles: [],
  });
}

test("createRunRow persists a queued run, retrievable by id, and rejects a duplicate id", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }
  seedSession(db, "session-1");

  const created = createRunRow(db, {
    id: "run-1",
    sessionId: "session-1",
    kind: "prompt",
    inputJson: JSON.stringify({ text: "hello" }),
  });

  assert.equal(created.status, "queued");
  assert.equal(created.version, 1);
  assert.equal(created.cancelRequested, false);
  assert.deepEqual(getRunRow(db, "run-1"), created);
  assert.throws(
    () =>
      createRunRow(db, {
        id: "run-1",
        sessionId: "session-1",
        kind: "prompt",
        inputJson: "{}",
      }),
    RunAlreadyExistsError,
  );
});

test("appendRunEventRow allocates strictly increasing sequence numbers with no duplicates", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }
  seedSession(db, "session-1");
  createRunRow(db, { id: "run-1", sessionId: "session-1", kind: "prompt", inputJson: "{}" });

  const first = appendRunEventRow(db, "run-1", JSON.stringify({ type: "message.delta" }));
  const second = appendRunEventRow(db, "run-1", JSON.stringify({ type: "message.completed" }));

  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  const events = listRunEventRowsAfter(db, "run-1", 0);
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2],
  );
});

test("listRunEventRowsAfter only returns events with a higher sequence number", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }
  seedSession(db, "session-1");
  createRunRow(db, { id: "run-1", sessionId: "session-1", kind: "prompt", inputJson: "{}" });
  appendRunEventRow(db, "run-1", JSON.stringify({ type: "a" }));
  appendRunEventRow(db, "run-1", JSON.stringify({ type: "b" }));
  appendRunEventRow(db, "run-1", JSON.stringify({ type: "c" }));

  const events = listRunEventRowsAfter(db, "run-1", 1);
  assert.deepEqual(
    events.map((event) => event.seq),
    [2, 3],
  );
});

test("getMaxRunEventSeq returns the highest seq for a run, or 0 when it has no events", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }
  seedSession(db, "session-1");
  createRunRow(db, { id: "run-1", sessionId: "session-1", kind: "prompt", inputJson: "{}" });

  assert.equal(getMaxRunEventSeq(db, "run-1"), 0);

  appendRunEventRow(db, "run-1", JSON.stringify({ type: "a" }));
  appendRunEventRow(db, "run-1", JSON.stringify({ type: "b" }));

  assert.equal(getMaxRunEventSeq(db, "run-1"), 2);
});

test("updateRunRow applies a patch when the version matches and rejects a stale version", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }
  seedSession(db, "session-1");
  const created = createRunRow(db, { id: "run-1", sessionId: "session-1", kind: "prompt", inputJson: "{}" });

  const running = updateRunRow(db, "run-1", created.version, {
    status: "running",
    startedAt: new Date(),
  });
  assert.equal(running.status, "running");
  assert.equal(running.version, 2);

  assert.throws(
    () => updateRunRow(db, "run-1", created.version, { status: "completed" }),
    RunVersionConflictError,
  );
});

test("updateRunRow throws RunRowNotFoundError for an unknown run", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }

  assert.throws(() => updateRunRow(db, "missing", 1, { status: "running" }), RunRowNotFoundError);
});

test("listRunsBySession returns only that session's runs, newest first", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }
  seedSession(db, "session-1");
  seedSession(db, "session-2");
  createRunRow(db, { id: "run-1", sessionId: "session-1", kind: "prompt", inputJson: "{}" });
  createRunRow(db, { id: "run-2", sessionId: "session-1", kind: "prompt", inputJson: "{}" });
  createRunRow(db, { id: "run-3", sessionId: "session-2", kind: "prompt", inputJson: "{}" });

  const runs = listRunsBySession(db, "session-1");

  assert.deepEqual(
    runs.map((run) => run.id).sort(),
    ["run-1", "run-2"],
  );
});
