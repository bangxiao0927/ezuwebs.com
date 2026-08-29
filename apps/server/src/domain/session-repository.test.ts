import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { type AgentEvent } from "@ezu/protocol";

import {
  createFileSessionRepository,
  createMemorySessionRepository,
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
