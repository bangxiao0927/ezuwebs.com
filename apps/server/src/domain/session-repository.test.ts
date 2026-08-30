import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { type AgentEvent } from "@ezu/protocol";

import {
  createFileSessionRepository,
  createMemorySessionRepository,
  importLegacyJsonSessionStore,
  type SessionRecord,
} from "./session-repository.js";

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

test("createMemorySessionRepository returns undefined for a session that was never created", async () => {
  const repository = createMemorySessionRepository();

  assert.equal(await repository.get("missing"), undefined);
});

test("createMemorySessionRepository returns a previously created session by id", async () => {
  const repository = createMemorySessionRepository();
  const record = makeRecord("session-1", []);

  await repository.create(record);

  const fetched = await repository.get("session-1");
  assert.equal(fetched?.id, "session-1");
});

test("listSummariesForOwner returns only the sessions owned by that user, without their events or webEditor state", async () => {
  const repository = createMemorySessionRepository();
  const owned = makeRecord("session-owned", []);
  owned.ownerUserId = "user-a";
  const other = makeRecord("session-other", []);
  other.ownerUserId = "user-b";
  await repository.create(owned);
  await repository.create(other);

  const summaries = await repository.listSummariesForOwner("user-a");

  assert.deepEqual(summaries, [{ id: "session-owned", definitionId: "club-promo" }]);
});

test("recoverInterruptedSessions appends failure events for actions left in progress, preserving prior events", async () => {
  const repository = createMemorySessionRepository();
  const action = {
    id: "action-1",
    source: "coder" as const,
    action: { type: "command.run" as const, command: "pnpm build" },
    status: "running" as const,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  const record = makeRecord("session-1", [{ type: "action.created", action }]);
  await repository.create(record);

  await repository.recoverInterruptedSessions();

  const recovered = await repository.get("session-1");
  assert.equal(recovered?.events.length, 3, "original event plus two recovery events");
  assert.equal(recovered?.events[0]?.type, "action.created");
  const lastEvent = recovered?.events.at(-1);
  assert.equal(lastEvent?.type, "execution.error");
});

test("createFileSessionRepository restores sessions across repository instances", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ezu-sessions-"));
  const file = path.join(directory, "sessions.json");
  try {
    const first = await createFileSessionRepository(file);
    await first.create(makeRecord("durable-session", []));

    const restarted = await createFileSessionRepository(file);
    assert.equal((await restarted.get("durable-session"))?.id, "durable-session");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("createFileSessionRepository recovers after a single failed flush so later saves still persist", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ezu-sessions-"));
  const file = path.join(directory, "sessions.json");
  try {
    let failNextWrite = true;
    const flakyFs = {
      readFile: fsPromises.readFile,
      mkdir: fsPromises.mkdir,
      rename: fsPromises.rename,
      async writeFile(targetPath: string, data: string, encoding: "utf8"): Promise<void> {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("simulated disk failure");
        }
        await fsPromises.writeFile(targetPath, data, encoding);
      },
    };

    const repository = await createFileSessionRepository(file, flakyFs);

    await assert.rejects(repository.create(makeRecord("session-a", [])), /simulated disk failure/);

    await repository.save(makeRecord("session-a", []));

    const restarted = await createFileSessionRepository(file);
    assert.equal((await restarted.get("session-a"))?.id, "session-a");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("createFileSessionRepository starts up despite a malformed persisted file, backing up the original", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ezu-sessions-"));
  const file = path.join(directory, "sessions.json");
  try {
    await fsPromises.writeFile(file, "{ not valid json", "utf8");

    const repository = await createFileSessionRepository(file);

    assert.deepEqual(await repository.list(), []);
    const siblingFiles = await fsPromises.readdir(directory);
    assert.ok(
      siblingFiles.some((name) => name.startsWith("sessions.json.corrupted-")),
      "the malformed file should be backed up instead of silently discarded",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("createFileSessionRepository drops invalid records from a persisted file while keeping the valid ones", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ezu-sessions-"));
  const file = path.join(directory, "sessions.json");
  try {
    const validRecord = makeRecord("session-valid", []);
    await fsPromises.writeFile(
      file,
      JSON.stringify([validRecord, { id: "session-invalid" }, "not-a-record"]),
      "utf8",
    );

    const repository = await createFileSessionRepository(file);

    const records = await repository.list();
    assert.deepEqual(
      records.map((record) => record.id),
      ["session-valid"],
    );
    const siblingFiles = await fsPromises.readdir(directory);
    assert.ok(
      siblingFiles.some((name) => name.startsWith("sessions.json.corrupted-")),
      "the file containing invalid records should be backed up",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("importLegacyJsonSessionStore is a no-op when the legacy file does not exist", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ezu-sessions-"));
  const file = path.join(directory, "sessions.json");
  try {
    const target = createMemorySessionRepository();

    const result = await importLegacyJsonSessionStore(file, target);

    assert.equal(result, undefined);
    assert.deepEqual(await target.list(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("importLegacyJsonSessionStore imports legacy records into an empty target and renames the source file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ezu-sessions-"));
  const file = path.join(directory, "sessions.json");
  try {
    await fsPromises.writeFile(file, JSON.stringify([makeRecord("legacy-1", [])]), "utf8");
    const target = createMemorySessionRepository();

    const result = await importLegacyJsonSessionStore(file, target);

    assert.deepEqual(result, { importedCount: 1, skippedExistingCount: 0 });
    assert.equal((await target.get("legacy-1"))?.id, "legacy-1");
    const siblingFiles = await fsPromises.readdir(directory);
    assert.ok(!siblingFiles.includes("sessions.json"), "the source file should have been renamed away");
    assert.ok(siblingFiles.some((name) => name.startsWith("sessions.json.imported-")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("importLegacyJsonSessionStore skips ids that already exist in the target instead of duplicating them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ezu-sessions-"));
  const file = path.join(directory, "sessions.json");
  try {
    const action = {
      id: "action-1",
      source: "coder" as const,
      action: { type: "command.run" as const, command: "pnpm build" },
      status: "running" as const,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    await fsPromises.writeFile(
      file,
      JSON.stringify([makeRecord("existing-1", [{ type: "action.created", action }])]),
      "utf8",
    );
    const target = createMemorySessionRepository();
    await target.create(makeRecord("existing-1", []));

    const result = await importLegacyJsonSessionStore(file, target);

    assert.deepEqual(result, { importedCount: 0, skippedExistingCount: 1 });
    assert.deepEqual((await target.get("existing-1"))?.events, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("importLegacyJsonSessionStore leaves the source file in place when a create fails, so a retry can pick up where it left off", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ezu-sessions-"));
  const file = path.join(directory, "sessions.json");
  try {
    await fsPromises.writeFile(
      file,
      JSON.stringify([makeRecord("legacy-a", []), makeRecord("legacy-b", [])]),
      "utf8",
    );
    const target = createMemorySessionRepository();
    const originalCreate = target.create.bind(target);
    let createCalls = 0;
    target.create = async (record) => {
      createCalls += 1;
      if (createCalls === 2) {
        throw new Error("simulated create failure");
      }
      await originalCreate(record);
    };

    await assert.rejects(importLegacyJsonSessionStore(file, target), /simulated create failure/);

    const siblingFiles = await fsPromises.readdir(directory);
    assert.ok(siblingFiles.includes("sessions.json"), "the source file must remain for a retry");
    assert.equal((await target.get("legacy-a"))?.id, "legacy-a");
    assert.equal(await target.get("legacy-b"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
