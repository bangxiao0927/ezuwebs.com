import test from "node:test";
import assert from "node:assert/strict";

import { createSqliteAuthStore } from "./sqlite-auth-store.js";

test("sqlite-backed auth store finds-or-creates a Google user and tracks sessions", async (t) => {
  const store = createSqliteAuthStore({ databaseUrl: ":memory:" });

  let user;
  try {
    user = await store.findOrCreateGoogleUser({
      subject: "google-subject-1",
      email: "ada@example.com",
      emailVerified: true,
      name: "Ada Lovelace",
    });
  } catch (cause) {
    // The better-sqlite3 native binding is not built for every sandbox; skip
    // this boundary test there instead of failing the whole suite.
    if (cause instanceof Error && /bindings file/.test(cause.message)) {
      t.skip("better-sqlite3 native binding is unavailable in this environment");
      return;
    }
    throw cause;
  }
  assert.equal(user.email, "ada@example.com");

  const sameUser = await store.findOrCreateGoogleUser({
    subject: "google-subject-1",
    email: "ada@example.com",
    emailVerified: true,
    name: "Ada Lovelace",
  });
  assert.equal(sameUser.id, user.id);

  await store.createAuthSession({
    userId: user.id,
    tokenHash: "hash-value",
    expiresAt: new Date(Date.now() + 60_000),
  });

  const activeUser = await store.findUserByActiveSession("hash-value");
  assert.equal(activeUser?.id, user.id);

  await store.revokeAuthSession("hash-value");
  assert.equal(await store.findUserByActiveSession("hash-value"), undefined);
});
