import test from "node:test";
import assert from "node:assert/strict";

import {
  configureSessionRepository,
  createSession,
  getSession,
  InteractionConflictError,
  listSessionsForOwner,
  resolveApproval,
  retryAction,
  selectBlock,
  SessionNotFoundError,
} from "./sessions.js";
import { createMemorySessionRepository, type SessionRepository } from "./session-repository.js";

function pendingApproval(session: {
  viewModel: { pendingInteraction?: { id: string; actionId?: string | undefined } | undefined };
}): {
  interactionId: string;
  actionId: string;
} {
  const interaction = session.viewModel.pendingInteraction;
  if (!interaction?.id || !interaction.actionId) {
    throw new Error("expected a pending confirm interaction gating an action");
  }
  return { interactionId: interaction.id, actionId: interaction.actionId };
}

function actionStatus(events: { type: string; action?: { id: string; status: string } }[], actionId: string) {
  let status: string | undefined;
  for (const event of events) {
    if ((event.type === "action.created" || event.type === "action.updated") && event.action?.id === actionId) {
      status = event.action.status;
    }
  }
  return status;
}

/**
 * Wraps a repository so its stored state is only ever visible or mutable
 * through clones, mirroring a real durable store: mutations a caller makes
 * to a fetched record do not take effect until a `save` call actually
 * succeeds against this wrapper.
 */
function asDurableStore(repository: SessionRepository): SessionRepository {
  return {
    async create(record) {
      await repository.create(structuredClone(record));
    },
    async get(id) {
      const record = await repository.get(id);
      return record ? structuredClone(record) : undefined;
    },
    async save(record) {
      await repository.save(structuredClone(record));
    },
    async list() {
      const records = await repository.list();
      return records.map((record) => structuredClone(record));
    },
    listSummariesForOwner: (ownerUserId) => repository.listSummariesForOwner(ownerUserId),
    recoverInterruptedSessions: () => repository.recoverInterruptedSessions(),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withConcurrencyTracking(repository: SessionRepository): {
  repository: SessionRepository;
  maxConcurrentBySession: Map<string, number>;
  maxConcurrentOverall: { value: number };
} {
  const concurrentBySession = new Map<string, number>();
  const maxConcurrentBySession = new Map<string, number>();
  const maxConcurrentOverall = { value: 0 };
  let overall = 0;

  function enter(sessionId: string): void {
    const next = (concurrentBySession.get(sessionId) ?? 0) + 1;
    concurrentBySession.set(sessionId, next);
    maxConcurrentBySession.set(sessionId, Math.max(maxConcurrentBySession.get(sessionId) ?? 0, next));
    overall += 1;
    maxConcurrentOverall.value = Math.max(maxConcurrentOverall.value, overall);
  }

  function exit(sessionId: string): void {
    concurrentBySession.set(sessionId, (concurrentBySession.get(sessionId) ?? 1) - 1);
    overall -= 1;
  }

  return {
    maxConcurrentBySession,
    maxConcurrentOverall,
    repository: {
      ...repository,
      async get(id) {
        enter(id);
        await delay(10);
        const record = await repository.get(id);
        exit(id);
        return record;
      },
    },
  };
}

test("getSession returns a session bound to its owner when requested by that owner", async () => {
  configureSessionRepository(createMemorySessionRepository());
  const session = await createSession("club-promo", "user-a");

  const fetched = await getSession(session.id, "user-a");

  assert.equal(fetched.id, session.id);
});

test("getSession rejects a request from a different user than the owner", async () => {
  configureSessionRepository(createMemorySessionRepository());
  const session = await createSession("club-promo", "user-a");

  await assert.rejects(getSession(session.id, "user-b"), SessionNotFoundError);
});

test("getSession rejects an anonymous request for a session owned by a user", async () => {
  configureSessionRepository(createMemorySessionRepository());
  const session = await createSession("club-promo", "user-a");

  await assert.rejects(getSession(session.id, undefined), SessionNotFoundError);
});

test("getSession allows anonymous access to a session created without an owner", async () => {
  configureSessionRepository(createMemorySessionRepository());
  const session = await createSession("club-promo");

  const fetched = await getSession(session.id, undefined);

  assert.equal(fetched.id, session.id);
});

test("listSessionsForOwner only returns sessions owned by that user", async () => {
  configureSessionRepository(createMemorySessionRepository());
  const ownedByA = await createSession("club-promo", "user-a");
  await createSession("club-promo", "user-b");
  await createSession("club-promo");

  const sessions = await listSessionsForOwner("user-a");

  assert.deepEqual(
    sessions.map((session) => session.id),
    [ownedByA.id],
  );
});

test("mutating operations on the same session never run concurrently", async () => {
  const tracked = withConcurrencyTracking(createMemorySessionRepository());
  configureSessionRepository(tracked.repository);
  const session = await createSession("club-promo");

  await Promise.all([selectBlock(session.id, "hero"), selectBlock(session.id, "footer")]);

  assert.equal(tracked.maxConcurrentBySession.get(session.id), 1);
});

test("mutating operations on different sessions can run concurrently", async () => {
  const tracked = withConcurrencyTracking(createMemorySessionRepository());
  configureSessionRepository(tracked.repository);
  const sessionA = await createSession("club-promo");
  const sessionB = await createSession("club-promo");

  await Promise.all([selectBlock(sessionA.id, "hero"), selectBlock(sessionB.id, "hero")]);

  assert.equal(tracked.maxConcurrentOverall.value, 2);
});

test("a rejected mutating operation releases the session lock for later calls on the same session", async () => {
  configureSessionRepository(createMemorySessionRepository());
  const session = await createSession("club-promo");

  await assert.rejects(
    resolveApproval(session.id, "not-a-real-interaction", "approved", ""),
    InteractionConflictError,
  );

  const fetched = await selectBlock(session.id, "hero");
  assert.equal(fetched.id, session.id);
});

test("resolveApproval persists the resolved interaction and a running action before executing the side effect", async () => {
  const memory = createMemorySessionRepository();
  const savedSnapshots: string[] = [];
  const recordingRepository: SessionRepository = {
    ...memory,
    async save(record) {
      await memory.save(record);
      savedSnapshots.push(JSON.stringify(record.events));
    },
  };
  configureSessionRepository(recordingRepository);

  const session = await createSession("club-promo");
  const { interactionId, actionId } = pendingApproval(session);

  await resolveApproval(session.id, interactionId, "approved", "");

  assert.ok(savedSnapshots.length >= 2, "expected a persist before execution and one after");
  const firstSave = JSON.parse(savedSnapshots[0]!) as { type: string; action?: { id: string; status: string } }[];
  assert.equal(actionStatus(firstSave, actionId), "running");
  const lastSave = JSON.parse(savedSnapshots.at(-1)!) as { type: string; action?: { id: string; status: string } }[];
  assert.equal(actionStatus(lastSave, actionId), "completed");
});

test("resolveApproval does not execute the gated action when persisting the resolution fails", async () => {
  const memory = createMemorySessionRepository();
  const durable = asDurableStore(memory);
  const failingRepository: SessionRepository = {
    ...durable,
    async save() {
      throw new Error("simulated persistence failure");
    },
  };
  configureSessionRepository(failingRepository);

  const session = await createSession("club-promo");
  const { interactionId, actionId } = pendingApproval(session);

  await assert.rejects(resolveApproval(session.id, interactionId, "approved", ""));

  const record = await durable.get(session.id);
  assert.equal(actionStatus(record?.events ?? [], actionId), "pending");
});

test("a running action left behind by an interrupted approval is marked failed and retryable on startup", async () => {
  const memory = createMemorySessionRepository();
  const durable = asDurableStore(memory);
  let saveCount = 0;
  const crashingRepository: SessionRepository = {
    ...durable,
    async save(record) {
      saveCount += 1;
      if (saveCount === 1) {
        await durable.save(record);
        return;
      }
      throw new Error("simulated crash before the completed action could persist");
    },
  };
  configureSessionRepository(crashingRepository);

  const session = await createSession("club-promo");
  const { interactionId, actionId } = pendingApproval(session);

  await assert.rejects(resolveApproval(session.id, interactionId, "approved", ""));
  assert.equal(actionStatus((await durable.get(session.id))?.events ?? [], actionId), "running");

  await durable.recoverInterruptedSessions();
  assert.equal(actionStatus((await durable.get(session.id))?.events ?? [], actionId), "failed");

  configureSessionRepository(durable);
  const retried = await retryAction(session.id, actionId);
  const retriedAction = retried.viewModel.actions.find((action) => action.id === actionId);
  assert.equal(retriedAction?.status, "completed");
});
