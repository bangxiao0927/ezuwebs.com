import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { openDatabase } from "./client.js";
import {
  createSessionRow,
  getSessionRowBundle,
  getWorkspaceBaselineRow,
  listSessionSummariesForOwner,
  listSessionIds,
  sessionRowExists,
  updateSessionRow,
  SessionAlreadyExistsError,
  SessionRowNotFoundError,
  SessionVersionConflictError,
} from "./sessions.js";

async function openTempDatabase(t: { after(fn: () => Promise<void> | void): void }) {
  const directory = await mkdtemp(path.join(tmpdir(), "ezu-sessions-db-"));
  const databaseUrl = path.join(directory, "sessions.db");
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

test("createSessionRow persists a session with its events and workspace files, retrievable by id", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }

  createSessionRow(db, {
    id: "session-1",
    definitionId: "club-promo",
    projectId: "project-1",
    bootstrapJson: JSON.stringify({ config: { projectName: "Test" } }),
    webEditorJson: JSON.stringify({ blocks: [], properties: [] }),
    workspaceBaselineVersion: "baseline-v1",
    events: [{ seq: 0, eventJson: JSON.stringify({ type: "session.created" }) }],
    workspaceFiles: [{ path: "README.md", content: "hello" }],
  });

  const bundle = getSessionRowBundle(db, "session-1");
  assert.ok(bundle);
  assert.equal(bundle?.session.version, 1);
  assert.equal(bundle?.events.length, 1);
  assert.equal(bundle?.events[0]?.seq, 0);
  assert.equal(bundle?.workspaceFiles.length, 1);
  assert.equal(bundle?.workspaceFiles[0]?.path, "README.md");
  assert.deepEqual(listSessionIds(db), ["session-1"]);
  assert.equal(sessionRowExists(db, "session-1"), true);
  assert.equal(sessionRowExists(db, "missing"), false);
});

test("createSessionRow rejects a duplicate id", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }

  const input = {
    id: "session-dup",
    definitionId: "club-promo",
    projectId: "project-1",
    bootstrapJson: "{}",
    webEditorJson: "{}",
    events: [],
    workspaceFiles: [],
  };
  createSessionRow(db, input);

  assert.throws(() => createSessionRow(db, input), SessionAlreadyExistsError);
});

test("updateSessionRow appends events, upserts and deletes workspace files, and bumps the version", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }

  createSessionRow(db, {
    id: "session-2",
    definitionId: "club-promo",
    projectId: "project-1",
    bootstrapJson: "{}",
    webEditorJson: "{}",
    events: [{ seq: 0, eventJson: JSON.stringify({ type: "session.created" }) }],
    workspaceFiles: [
      { path: "a.txt", content: "a" },
      { path: "b.txt", content: "b" },
    ],
  });

  const updated = updateSessionRow(db, {
    id: "session-2",
    expectedVersion: 1,
    bootstrapJson: "{}",
    webEditorJson: "{}",
    newEvents: [{ seq: 1, eventJson: JSON.stringify({ type: "message.completed" }) }],
    workspaceUpserts: [{ path: "a.txt", content: "a2" }],
    workspaceDeletePaths: ["b.txt"],
  });

  assert.equal(updated.version, 2);
  const bundle = getSessionRowBundle(db, "session-2");
  assert.equal(bundle?.events.length, 2);
  assert.deepEqual(
    bundle?.workspaceFiles.map((file) => [file.path, file.content]),
    [["a.txt", "a2"]],
  );
});

test("updateSessionRow rejects a stale version instead of silently overwriting", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }

  createSessionRow(db, {
    id: "session-3",
    definitionId: "club-promo",
    projectId: "project-1",
    bootstrapJson: "{}",
    webEditorJson: "{}",
    events: [],
    workspaceFiles: [],
  });

  updateSessionRow(db, {
    id: "session-3",
    expectedVersion: 1,
    bootstrapJson: "{}",
    webEditorJson: "{}",
    newEvents: [],
    workspaceUpserts: [],
    workspaceDeletePaths: [],
  });

  assert.throws(
    () =>
      updateSessionRow(db, {
        id: "session-3",
        expectedVersion: 1,
        bootstrapJson: "{}",
        webEditorJson: "{}",
        newEvents: [],
        workspaceUpserts: [],
        workspaceDeletePaths: [],
      }),
    SessionVersionConflictError,
  );
});

test("updateSessionRow rejects an unknown session id", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }

  assert.throws(
    () =>
      updateSessionRow(db, {
        id: "missing",
        expectedVersion: 1,
        bootstrapJson: "{}",
        webEditorJson: "{}",
        newEvents: [],
        workspaceUpserts: [],
        workspaceDeletePaths: [],
      }),
    SessionRowNotFoundError,
  );
});

test("createSessionRow persists the referenced workspace baseline snapshot once", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }

  const filesJson = JSON.stringify([{ path: "README.md", content: "hello" }]);
  createSessionRow(db, {
    id: "session-4",
    definitionId: "club-promo",
    projectId: "project-1",
    bootstrapJson: "{}",
    webEditorJson: "{}",
    workspaceBaselineVersion: "baseline-v1",
    workspaceBaseline: { version: "baseline-v1", filesJson },
    events: [],
    workspaceFiles: [],
  });

  const baseline = getWorkspaceBaselineRow(db, "baseline-v1");
  assert.equal(baseline?.filesJson, filesJson);
});

test("createSessionRow does not overwrite an already-stored baseline for the same version", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }

  const originalFilesJson = JSON.stringify([{ path: "README.md", content: "original" }]);
  createSessionRow(db, {
    id: "session-5",
    definitionId: "club-promo",
    projectId: "project-1",
    bootstrapJson: "{}",
    webEditorJson: "{}",
    workspaceBaselineVersion: "baseline-v1",
    workspaceBaseline: { version: "baseline-v1", filesJson: originalFilesJson },
    events: [],
    workspaceFiles: [],
  });

  const rewrittenFilesJson = JSON.stringify([{ path: "README.md", content: "rewritten" }]);
  createSessionRow(db, {
    id: "session-6",
    definitionId: "club-promo",
    projectId: "project-1",
    bootstrapJson: "{}",
    webEditorJson: "{}",
    workspaceBaselineVersion: "baseline-v1",
    workspaceBaseline: { version: "baseline-v1", filesJson: rewrittenFilesJson },
    events: [],
    workspaceFiles: [],
  });

  const baseline = getWorkspaceBaselineRow(db, "baseline-v1");
  assert.equal(baseline?.filesJson, originalFilesJson);
});

test("updateSessionRow persists a new workspace baseline version encountered on save", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }

  createSessionRow(db, {
    id: "session-7",
    definitionId: "club-promo",
    projectId: "project-1",
    bootstrapJson: "{}",
    webEditorJson: "{}",
    events: [],
    workspaceFiles: [],
  });

  const filesJson = JSON.stringify([{ path: "README.md", content: "hello" }]);
  updateSessionRow(db, {
    id: "session-7",
    expectedVersion: 1,
    bootstrapJson: "{}",
    webEditorJson: "{}",
    workspaceBaselineVersion: "baseline-v2",
    workspaceBaseline: { version: "baseline-v2", filesJson },
    newEvents: [],
    workspaceUpserts: [],
    workspaceDeletePaths: [],
  });

  const baseline = getWorkspaceBaselineRow(db, "baseline-v2");
  assert.equal(baseline?.filesJson, filesJson);
});

test("listSessionSummariesForOwner returns only id and definitionId for sessions owned by that user", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }

  createSessionRow(db, {
    id: "session-owned",
    ownerUserId: "user-a",
    definitionId: "club-promo",
    projectId: "project-1",
    // A malformed bootstrap JSON that would throw if a summary query parsed it.
    bootstrapJson: "{ not valid json",
    webEditorJson: "{ not valid json",
    events: [],
    workspaceFiles: [],
  });
  createSessionRow(db, {
    id: "session-other",
    ownerUserId: "user-b",
    definitionId: "club-promo",
    projectId: "project-1",
    bootstrapJson: "{}",
    webEditorJson: "{}",
    events: [],
    workspaceFiles: [],
  });

  const summaries = listSessionSummariesForOwner(db, "user-a");

  assert.deepEqual(summaries, [{ id: "session-owned", definitionId: "club-promo" }]);
});
