import test from "node:test";
import assert from "node:assert/strict";

import { createUser, openDatabase } from "@ezu/db";

import { createSqliteBillingStore } from "./sqlite-billing-store.js";

test("sqlite-backed billing store enforces idempotent grants and sufficient-balance debits", async (t) => {
  const databaseUrl = ":memory:";
  let db;
  try {
    db = openDatabase({ databaseUrl, runMigrations: true });
  } catch (cause) {
    // The better-sqlite3 native binding is not built for every sandbox; skip
    // this boundary test there instead of failing the whole suite.
    if (cause instanceof Error && /bindings file/.test(cause.message)) {
      t.skip("better-sqlite3 native binding is unavailable in this environment");
      return;
    }
    throw cause;
  }

  const user = createUser(db, { email: "billing-user@example.com" });
  const store = createSqliteBillingStore({ databaseUrl });

  const firstGrant = await store.appendGrant({
    userId: user.id,
    amount: 100,
    reason: "initial free grant",
    idempotencyKey: `initial-grant:${user.id}`,
  });
  const replayedGrant = await store.appendGrant({
    userId: user.id,
    amount: 100,
    reason: "initial free grant",
    idempotencyKey: `initial-grant:${user.id}`,
  });
  assert.equal(firstGrant.applied, true);
  assert.equal(replayedGrant.applied, false);
  assert.equal(await store.getBalance(user.id), 100);

  const shortfall = await store.debitIfSufficient({
    userId: user.id,
    credits: 1000,
    reason: "usage: prompt",
    idempotencyKey: "usage:1",
  });
  assert.equal(shortfall.sufficient, false);
  assert.equal(await store.getBalance(user.id), 100);

  const debited = await store.debitIfSufficient({
    userId: user.id,
    credits: 30,
    reason: "usage: prompt",
    idempotencyKey: "usage:2",
  });
  assert.equal(debited.applied, true);
  assert.equal(debited.balance, 70);

  await store.insertUsageEvent({ userId: user.id, kind: "prompt", units: 1, credits: 30 });
  const page = await store.listUsageEvents(user.id, { limit: 10, offset: 0 });
  assert.equal(page.total, 1);
  assert.equal(page.totalCreditsConsumed, 30);
  assert.equal(page.events[0]?.kind, "prompt");
});
