import test from "node:test";
import assert from "node:assert/strict";

import {
  configureSessionRepository,
  createSession,
  getSession,
  listSessionsForOwner,
  SessionNotFoundError,
} from "./sessions.js";
import { createMemorySessionRepository } from "./session-repository.js";

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
