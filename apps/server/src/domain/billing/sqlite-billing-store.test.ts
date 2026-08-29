import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createUser, openDatabase } from "@ezu/db";

import { createSqliteBillingStore } from "./sqlite-billing-store.js";

test("sqlite-backed billing store enforces idempotent grants and sufficient-balance debits", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ezu-billing-"));
  const databaseUrl = path.join(directory, "billing.db");
  t.after(() => rm(directory, { recursive: true, force: true }));
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

  await store.insertUsageEvent({ id: "usage-event:1", userId: user.id, kind: "prompt", units: 1, credits: 30 });
  const page = await store.listUsageEvents(user.id, { limit: 10, offset: 0 });
  assert.equal(page.total, 1);
  assert.equal(page.totalCreditsConsumed, 30);
  assert.equal(page.events[0]?.kind, "prompt");
  assert.equal(page.events[0]?.status, "succeeded");

  const firstRefund = await store.refundDebit({
    userId: user.id,
    credits: 30,
    reason: "refund: prompt failed",
    debitIdempotencyKey: "usage:2",
  });
  const replayedRefund = await store.refundDebit({
    userId: user.id,
    credits: 30,
    reason: "refund: prompt failed",
    debitIdempotencyKey: "usage:2",
  });
  assert.equal(firstRefund.applied, true);
  assert.equal(firstRefund.balance, 100);
  assert.equal(replayedRefund.applied, false);
  assert.equal(await store.getBalance(user.id), 100);

  await store.markUsageEventRefunded("usage-event:1");
  const afterRefund = await store.listUsageEvents(user.id, { limit: 10, offset: 0 });
  assert.equal(afterRefund.events[0]?.status, "refunded");
  assert.equal(afterRefund.totalCreditsConsumed, 0);
  assert.equal(await store.getUsageEventStatus("usage-event:1"), "refunded");
  assert.equal(await store.getUsageEventStatus("no-such-event"), undefined);
});
