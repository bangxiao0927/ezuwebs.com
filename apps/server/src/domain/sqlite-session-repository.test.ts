import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { type EzuDb } from "@ezu/db";
import { type AgentEvent } from "@ezu/protocol";

import {
  createSqliteSessionRepository,
  SessionSaveConflictError,
} from "./sqlite-session-repository.js";
import { type SessionRecord, type SessionRepository } from "./session-repository.js";
import { getDefaultWorkspaceSnapshot, WorkspaceBaselineMissingError } from "./workspace.js";

function makeRecord(id: string, events: AgentEvent[]): SessionRecord {
  return {
    id,
    definitionId: "club-promo",
    bootstrap: {
      config: { projectName: "Test", runtimeType: "browser" },
      initialEvents: [],
      sessionId: id,
      projectId: "project-1",
    },
    events,
    webEditor: { blocks: [], properties: [] },
  };
}

interface TestRepository {
  repository: SessionRepository;
  db: EzuDb;
}

async function openTestRepository(t: {
  after(fn: () => Promise<void> | void): void;
  skip(message: string): void;
}): Promise<TestRepository | undefined> {
  const directory = await mkdtemp(path.join(tmpdir(), "ezu-sessions-sqlite-"));
  const databaseUrl = path.join(directory, "sessions.db");

  const { openDatabase } = await import("@ezu/db");
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

  return { repository: createSqliteSessionRepository({ db }), db };
}

test("createSqliteSessionRepository restores a created session by id", async (t) => {
  const testRepository = await openTestRepository(t);
  if (!testRepository) return;
  const { repository } = testRepository;

  await repository.create(makeRecord("session-1", []));

  const fetched = await repository.get("session-1");
  assert.equal(fetched?.id, "session-1");
  assert.equal(fetched?.bootstrap.config.projectName, "Test");
});

test("createSqliteSessionRepository appends events across saves without rewriting history", async (t) => {
  const testRepository = await openTestRepository(t);
  if (!testRepository) return;
  const { repository } = testRepository;

  const firstEvent: AgentEvent = { type: "session.lifecycle", status: "active" };
  await repository.create(makeRecord("session-2", [firstEvent]));

  const record = await repository.get("session-2");
  assert.ok(record);
  const secondEvent: AgentEvent = { type: "session.lifecycle", status: "completed" };
  record.events = [...record.events, secondEvent];
  await repository.save(record);

  const reloaded = await repository.get("session-2");
  assert.deepEqual(reloaded?.events, [firstEvent, secondEvent]);
});

test("createSqliteSessionRepository persists workspace file changes and removals across reloads", async (t) => {
  const testRepository = await openTestRepository(t);
  if (!testRepository) return;
  const { repository } = testRepository;

  const baseline = getDefaultWorkspaceSnapshot();
  const initialFiles = baseline.files.slice(0, 2);
  const record = makeRecord("session-3", []);
  record.bootstrap = { ...record.bootstrap, workspaceFiles: initialFiles };
  await repository.create(record);

  const loaded = await repository.get("session-3");
  assert.ok(loaded);
  assert.deepEqual(
    [...loaded.bootstrap.workspaceFiles ?? []].sort((a, b) => a.path.localeCompare(b.path)),
    [...initialFiles].sort((a, b) => a.path.localeCompare(b.path)),
  );

  const changedFiles = [
    { path: initialFiles[0]!.path, content: "changed by user" },
    { path: "brand-new-file.txt", content: "created by user" },
  ];
  loaded.bootstrap = { ...loaded.bootstrap, workspaceFiles: changedFiles };
  await repository.save(loaded);

  const reloaded = await repository.get("session-3");
  const reloadedPaths = new Set((reloaded?.bootstrap.workspaceFiles ?? []).map((file) => file.path));
  assert.ok(reloadedPaths.has("brand-new-file.txt"));
  assert.equal(
    reloaded?.bootstrap.workspaceFiles?.find((file) => file.path === initialFiles[0]!.path)?.content,
    "changed by user",
  );
  assert.ok(!reloadedPaths.has(initialFiles[1]!.path));
});

test("createSqliteSessionRepository keeps sessions with no workspaceFiles undefined across a reload", async (t) => {
  const testRepository = await openTestRepository(t);
  if (!testRepository) return;
  const { repository } = testRepository;

  await repository.create(makeRecord("session-4", []));

  const reloaded = await repository.get("session-4");
  assert.equal(reloaded?.bootstrap.workspaceFiles, undefined);
});

test("createSqliteSessionRepository lists sessions owned by a user and filters others out", async (t) => {
  const testRepository = await openTestRepository(t);
  if (!testRepository) return;
  const { repository, db } = testRepository;
  const { createUser } = await import("@ezu/db");
  const owner = createUser(db, { email: "owner@example.com" });

  const owned = makeRecord("session-5", []);
  owned.ownerUserId = owner.id;
  await repository.create(owned);
  await repository.create(makeRecord("session-6", []));

  const all = await repository.list();
  const ownerIds = all.filter((record) => record.ownerUserId === owner.id).map((record) => record.id);
  assert.deepEqual(ownerIds, ["session-5"]);
});

test("createSqliteSessionRepository recovers actions left running, preserving prior events", async (t) => {
  const testRepository = await openTestRepository(t);
  if (!testRepository) return;
  const { repository } = testRepository;

  const action = {
    id: "action-1",
    source: "coder" as const,
    action: { type: "command.run" as const, command: "pnpm build" },
    status: "running" as const,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  await repository.create(makeRecord("session-7", [{ type: "action.created", action }]));

  await repository.recoverInterruptedSessions();

  const recovered = await repository.get("session-7");
  assert.equal(recovered?.events.length, 3, "original event plus two recovery events");
  assert.equal(recovered?.events.at(-1)?.type, "execution.error");
});

test("createSqliteSessionRepository rejects a save whose expected version is stale", async (t) => {
  const testRepository = await openTestRepository(t);
  if (!testRepository) return;
  const { repository } = testRepository;

  await repository.create(makeRecord("session-8", []));
  const firstRead = await repository.get("session-8");
  const secondRead = await repository.get("session-8");
  assert.ok(firstRead);
  assert.ok(secondRead);

  firstRead.events = [...firstRead.events, { type: "session.lifecycle", status: "active" }];
  await repository.save(firstRead);

  secondRead.events = [...secondRead.events, { type: "session.lifecycle", status: "paused" }];
  await assert.rejects(repository.save(secondRead), SessionSaveConflictError);
});

test("createSqliteSessionRepository reconstructs workspace files from the baseline version stored on the session, not the current deploy baseline", async (t) => {
  const testRepository = await openTestRepository(t);
  if (!testRepository) return;
  const { repository, db } = testRepository;
  const { createSessionRow } = await import("@ezu/db");

  // Simulates a session created under an older deploy whose workspace
  // baseline snapshot differed from the current one.
  const staleBaselineFiles = [
    { path: "old-only.txt", content: "from an old deploy" },
    { path: "shared.txt", content: "old content" },
  ];
  createSessionRow(db, {
    id: "session-9",
    definitionId: "club-promo",
    projectId: "project-1",
    bootstrapJson: JSON.stringify({ config: { projectName: "Test", runtimeType: "browser" } }),
    webEditorJson: JSON.stringify({ blocks: [], properties: [] }),
    workspaceBaselineVersion: "stale-baseline-v1",
    workspaceBaseline: { version: "stale-baseline-v1", filesJson: JSON.stringify(staleBaselineFiles) },
    events: [],
    workspaceFiles: [{ path: "shared.txt", content: "edited by user" }],
  });

  const loaded = await repository.get("session-9");
  assert.ok(loaded);
  const filesByPath = new Map((loaded.bootstrap.workspaceFiles ?? []).map((file) => [file.path, file.content]));
  assert.equal(filesByPath.get("old-only.txt"), "from an old deploy");
  assert.equal(filesByPath.get("shared.txt"), "edited by user");

  const currentBaselinePaths = new Set(getDefaultWorkspaceSnapshot().files.map((file) => file.path));
  assert.ok(!currentBaselinePaths.has("old-only.txt"));
});

test("createSqliteSessionRepository throws a controlled error when a session's workspace baseline is missing", async (t) => {
  const testRepository = await openTestRepository(t);
  if (!testRepository) return;
  const { repository, db } = testRepository;
  const { createSessionRow } = await import("@ezu/db");

  createSessionRow(db, {
    id: "session-10",
    definitionId: "club-promo",
    projectId: "project-1",
    bootstrapJson: JSON.stringify({ config: { projectName: "Test", runtimeType: "browser" } }),
    webEditorJson: JSON.stringify({ blocks: [], properties: [] }),
    workspaceBaselineVersion: "never-stored-baseline",
    events: [],
    workspaceFiles: [{ path: "shared.txt", content: "edited by user" }],
  });

  await assert.rejects(repository.get("session-10"), WorkspaceBaselineMissingError);
});

test("createSqliteSessionRepository lists owner-scoped summaries without hydrating other owners' sessions", async (t) => {
  const testRepository = await openTestRepository(t);
  if (!testRepository) return;
  const { repository, db } = testRepository;
  const { createUser, createSessionRow } = await import("@ezu/db");
  const owner = createUser(db, { email: "owner@example.com" });

  const owned = makeRecord("session-11", []);
  owned.ownerUserId = owner.id;
  await repository.create(owned);

  // A session belonging to another owner, whose bootstrap/events would
  // throw if a summary listing ever parsed them.
  createSessionRow(db, {
    id: "session-12",
    ownerUserId: "user-b",
    definitionId: "club-promo",
    projectId: "project-1",
    bootstrapJson: "{ not valid json",
    webEditorJson: "{ not valid json",
    events: [{ seq: 0, eventJson: "{ not valid json" }],
    workspaceFiles: [],
  });

  const summaries = await repository.listSummariesForOwner(owner.id);

  assert.deepEqual(summaries, [{ id: "session-11", definitionId: "club-promo" }]);
});
