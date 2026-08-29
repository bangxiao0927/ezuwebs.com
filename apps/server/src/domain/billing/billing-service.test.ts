import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryBillingStore } from "./memory-billing-store.js";
import {
  DevGrantsDisabledError,
  FREE_GRANT_CREDITS,
  InsufficientCreditsError,
  MissingIdempotencyKeyError,
  UnknownDevGrantPackageError,
  USAGE_COSTS,
  chargeUsage,
  configureBillingStore,
  getBillingSummary,
  grantDevCredits,
  listBillingUsage,
  refundUsageCharge,
} from "./billing-service.js";

function resetBilling(): void {
  configureBillingStore(createMemoryBillingStore());
  delete process.env["BILLING_DEV_GRANTS"];
}

test("getBillingSummary grants the initial free credits exactly once", async () => {
  resetBilling();

  const first = await getBillingSummary("user-a");
  const second = await getBillingSummary("user-a");

  assert.equal(first.balance, FREE_GRANT_CREDITS);
  assert.equal(second.balance, FREE_GRANT_CREDITS);
});

test("balances are isolated between users", async () => {
  resetBilling();

  await chargeUsage({ userId: "user-a", kind: "prompt", requestId: "req-1" });
  const summaryA = await getBillingSummary("user-a");
  const summaryB = await getBillingSummary("user-b");

  assert.equal(summaryA.balance, FREE_GRANT_CREDITS - USAGE_COSTS["prompt"]!);
  assert.equal(summaryB.balance, FREE_GRANT_CREDITS);
});

test("chargeUsage rejects a charge once the balance is insufficient, leaving the balance unchanged", async () => {
  resetBilling();
  await getBillingSummary("user-a");
  const chargesUntilDrained = Math.floor(FREE_GRANT_CREDITS / USAGE_COSTS["prompt"]!);
  for (let i = 0; i < chargesUntilDrained; i += 1) {
    await chargeUsage({ userId: "user-a", kind: "prompt", requestId: `req-${i}` });
  }
  const balanceBefore = await getBillingSummary("user-a");

  await assert.rejects(
    chargeUsage({ userId: "user-a", kind: "prompt", requestId: "req-final" }),
    InsufficientCreditsError,
  );

  const balanceAfter = await getBillingSummary("user-a");
  assert.equal(balanceAfter.balance, balanceBefore.balance);
});

test("chargeUsage requires a requestId", async () => {
  resetBilling();
  await assert.rejects(
    chargeUsage({ userId: "user-a", kind: "prompt", requestId: "" }),
    MissingIdempotencyKeyError,
  );
});

test("chargeUsage is idempotent: replaying the same requestId does not debit twice", async () => {
  resetBilling();

  const first = await chargeUsage({ userId: "user-a", kind: "prompt", requestId: "req-1" });
  const replay = await chargeUsage({ userId: "user-a", kind: "prompt", requestId: "req-1" });

  assert.equal(first.applied, true);
  assert.equal(replay.applied, false);
  assert.equal(replay.usageEventId, first.usageEventId);

  const summary = await getBillingSummary("user-a");
  assert.equal(summary.balance, FREE_GRANT_CREDITS - USAGE_COSTS["prompt"]!);

  const page = await listBillingUsage("user-a");
  assert.equal(page.events.length, 1);
});

test("refundUsageCharge credits back a charged debit and marks the usage event refunded", async () => {
  resetBilling();
  await chargeUsage({ userId: "user-a", kind: "prompt", requestId: "req-1" });

  await refundUsageCharge({ userId: "user-a", kind: "prompt", requestId: "req-1", reason: "agent failed" });

  const summary = await getBillingSummary("user-a");
  assert.equal(summary.balance, FREE_GRANT_CREDITS);

  const page = await listBillingUsage("user-a");
  assert.equal(page.events[0]?.status, "refunded");
  assert.equal(page.totalCreditsConsumed, 0);
});

test("refundUsageCharge is idempotent: replaying it does not refund twice", async () => {
  resetBilling();
  await chargeUsage({ userId: "user-a", kind: "prompt", requestId: "req-1" });

  await refundUsageCharge({ userId: "user-a", kind: "prompt", requestId: "req-1", reason: "agent failed" });
  await refundUsageCharge({ userId: "user-a", kind: "prompt", requestId: "req-1", reason: "agent failed" });

  const summary = await getBillingSummary("user-a");
  assert.equal(summary.balance, FREE_GRANT_CREDITS);
});

test("chargeUsage records a usage event that shows up in listBillingUsage", async () => {
  resetBilling();
  await chargeUsage({ userId: "user-a", kind: "prompt", sessionId: "session-1", requestId: "req-1" });

  const page = await listBillingUsage("user-a");

  assert.equal(page.events.length, 1);
  assert.equal(page.events[0]?.kind, "prompt");
  assert.equal(page.events[0]?.sessionId, "session-1");
  assert.equal(page.events[0]?.status, "succeeded");
  assert.equal(page.total, 1);
  assert.equal(page.totalCreditsConsumed, USAGE_COSTS["prompt"]);
});

test("listBillingUsage clamps limit and offset to safe bounds", async () => {
  resetBilling();
  for (let i = 0; i < 5; i += 1) {
    await chargeUsage({ userId: "user-a", kind: "prompt", requestId: `req-${i}` });
  }

  const page = await listBillingUsage("user-a", { limit: 2, offset: 1 });
  assert.equal(page.events.length, 2);
  assert.equal(page.total, 5);

  const negativeOffset = await listBillingUsage("user-a", { limit: -5, offset: -5 });
  assert.equal(negativeOffset.limit, 1);
  assert.equal(negativeOffset.offset, 0);
});

test("grantDevCredits is disabled unless BILLING_DEV_GRANTS=true", async () => {
  resetBilling();
  await assert.rejects(grantDevCredits("user-a", "does-not-matter"), DevGrantsDisabledError);
});

test("grantDevCredits rejects package ids the server did not define", async () => {
  resetBilling();
  process.env["BILLING_DEV_GRANTS"] = "true";
  await assert.rejects(grantDevCredits("user-a", "not-a-real-package"), UnknownDevGrantPackageError);
});

test("grantDevCredits adds the server-defined package amount and is exposed in the summary", async () => {
  resetBilling();
  process.env["BILLING_DEV_GRANTS"] = "true";
  const before = await getBillingSummary("user-a");
  const packageId = before.devGrantPackages[0]!.id;
  const packageCredits = before.devGrantPackages[0]!.credits;

  const after = await grantDevCredits("user-a", packageId);

  assert.equal(after.balance, before.balance + packageCredits);
});
