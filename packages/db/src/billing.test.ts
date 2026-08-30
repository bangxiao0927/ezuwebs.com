import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { openDatabase } from "./client.js";
import { createUser } from "./users.js";
import { appendLedgerEntry, debitAndRecordUsage, getLedgerBalance, getSettlement, settleUsage } from "./billing.js";

async function openTempDatabase(t: { after(fn: () => Promise<void> | void): void }) {
  const directory = await mkdtemp(path.join(tmpdir(), "ezu-billing-db-"));
  const databaseUrl = path.join(directory, "billing.db");
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

test("settleUsage refunds the difference when the final charge is below the reservation", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }
  const user = createUser(db, { email: "settle-refund@example.com" });
  appendLedgerEntry(db, { userId: user.id, type: "grant", amount: 100, reason: "grant", idempotencyKey: "grant:1" });
  debitAndRecordUsage(db, {
    userId: user.id,
    credits: 10,
    reason: "usage: prompt",
    idempotencyKey: "usage-debit:run-1",
    usageEvent: { id: "usage-event:run-1", userId: user.id, kind: "prompt", units: 1, credits: 10, metering: "estimated" },
  });

  const result = settleUsage(db, {
    userId: user.id,
    runId: "run-1",
    usageEventId: "usage-event:run-1",
    reservedCredits: 10,
    finalCredits: 3,
    units: 2500,
    model: "gpt-4o-mini",
    metering: "actual",
    reason: "usage settlement: prompt",
  });

  assert.equal(result.applied, true);
  assert.equal(result.sufficient, true);
  assert.equal(result.finalCredits, 3);
  assert.equal(result.balance, 97);
  assert.equal(getLedgerBalance(db, user.id), 97);
});

test("settleUsage debits the difference when the final charge exceeds the reservation", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }
  const user = createUser(db, { email: "settle-debit@example.com" });
  appendLedgerEntry(db, { userId: user.id, type: "grant", amount: 100, reason: "grant", idempotencyKey: "grant:1" });
  debitAndRecordUsage(db, {
    userId: user.id,
    credits: 10,
    reason: "usage: prompt",
    idempotencyKey: "usage-debit:run-1",
    usageEvent: { id: "usage-event:run-1", userId: user.id, kind: "prompt", units: 1, credits: 10, metering: "estimated" },
  });

  const result = settleUsage(db, {
    userId: user.id,
    runId: "run-1",
    usageEventId: "usage-event:run-1",
    reservedCredits: 10,
    finalCredits: 25,
    units: 24_500,
    model: "gpt-4o",
    metering: "actual",
    reason: "usage settlement: prompt",
  });

  assert.equal(result.applied, true);
  assert.equal(result.sufficient, true);
  assert.equal(result.finalCredits, 25);
  assert.equal(result.balance, 75);
  assert.equal(getLedgerBalance(db, user.id), 75);
});

test("settleUsage never overdraws the balance: an insufficient top-up keeps the reservation and reports insufficient", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }
  const user = createUser(db, { email: "settle-insufficient@example.com" });
  appendLedgerEntry(db, { userId: user.id, type: "grant", amount: 10, reason: "grant", idempotencyKey: "grant:1" });
  debitAndRecordUsage(db, {
    userId: user.id,
    credits: 10,
    reason: "usage: prompt",
    idempotencyKey: "usage-debit:run-1",
    usageEvent: { id: "usage-event:run-1", userId: user.id, kind: "prompt", units: 1, credits: 10, metering: "estimated" },
  });

  const result = settleUsage(db, {
    userId: user.id,
    runId: "run-1",
    usageEventId: "usage-event:run-1",
    reservedCredits: 10,
    finalCredits: 40,
    units: 39_500,
    model: "gpt-4o",
    metering: "actual",
    reason: "usage settlement: prompt",
  });

  assert.equal(result.applied, true);
  assert.equal(result.sufficient, false);
  assert.equal(result.finalCredits, 10);
  assert.equal(result.balance, 0);
  assert.equal(getLedgerBalance(db, user.id), 0);
});

test("settleUsage is idempotent: replaying the same runId does not settle twice", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }
  const user = createUser(db, { email: "settle-idempotent@example.com" });
  appendLedgerEntry(db, { userId: user.id, type: "grant", amount: 100, reason: "grant", idempotencyKey: "grant:1" });
  debitAndRecordUsage(db, {
    userId: user.id,
    credits: 10,
    reason: "usage: prompt",
    idempotencyKey: "usage-debit:run-1",
    usageEvent: { id: "usage-event:run-1", userId: user.id, kind: "prompt", units: 1, credits: 10, metering: "estimated" },
  });

  const settleInput = {
    userId: user.id,
    runId: "run-1",
    usageEventId: "usage-event:run-1",
    reservedCredits: 10,
    finalCredits: 25,
    units: 24_500,
    model: "gpt-4o",
    metering: "actual" as const,
    reason: "usage settlement: prompt",
  };

  const first = settleUsage(db, settleInput);
  const replay = settleUsage(db, settleInput);

  assert.equal(first.applied, true);
  assert.equal(replay.applied, false);
  assert.equal(replay.sufficient, true);
  assert.equal(replay.finalCredits, 25);
  assert.equal(getLedgerBalance(db, user.id), 75);
});

test("getSettlement returns undefined until a settlement is recorded for the run, then reports it", async (t) => {
  const db = await openTempDatabase(t);
  if (!db) {
    t.skip("better-sqlite3 native binding is unavailable in this environment");
    return;
  }
  const user = createUser(db, { email: "get-settlement@example.com" });
  appendLedgerEntry(db, { userId: user.id, type: "grant", amount: 100, reason: "grant", idempotencyKey: "grant:1" });
  debitAndRecordUsage(db, {
    userId: user.id,
    credits: 10,
    reason: "usage: prompt",
    idempotencyKey: "usage-debit:run-1",
    usageEvent: { id: "usage-event:run-1", userId: user.id, kind: "prompt", units: 1, credits: 10, metering: "estimated" },
  });

  assert.equal(getSettlement(db, "run-1"), undefined);

  settleUsage(db, {
    userId: user.id,
    runId: "run-1",
    usageEventId: "usage-event:run-1",
    reservedCredits: 10,
    finalCredits: 3,
    metering: "actual",
    reason: "usage settlement: prompt",
  });

  const settlement = getSettlement(db, "run-1");
  assert.equal(settlement?.applied, true);
  assert.equal(settlement?.sufficient, true);
  assert.equal(settlement?.finalCredits, 3);
});
