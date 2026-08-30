import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryBillingStore } from "./memory-billing-store.js";
import {
  DEV_GRANT_PACKAGES,
  DevGrantsDisabledError,
  FREE_GRANT_CREDITS,
  InsufficientCreditsError,
  MissingIdempotencyKeyError,
  PreviousAttemptFailedError,
  RefundConflictError,
  UnknownDevGrantPackageError,
  USAGE_COSTS,
  chargeUsage,
  configureBillingStore,
  getBillingSummary,
  grantDevCredits,
  listBillingUsage,
  refundUsageCharge,
  settleRunUsage,
  SettlementAlreadyAppliedError,
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

test("refundUsageCharge rejects a requestId that was never charged, leaving the balance unchanged", async () => {
  resetBilling();
  await getBillingSummary("user-a");

  await assert.rejects(
    refundUsageCharge({ userId: "user-a", kind: "prompt", requestId: "never-charged", reason: "fabricated" }),
    RefundConflictError,
  );

  const summary = await getBillingSummary("user-a");
  assert.equal(summary.balance, FREE_GRANT_CREDITS);
});

test("refundUsageCharge rejects refunding a different user's charge", async () => {
  resetBilling();
  await chargeUsage({ userId: "user-a", kind: "prompt", requestId: "req-1" });

  await assert.rejects(
    refundUsageCharge({ userId: "user-b", kind: "prompt", requestId: "req-1", reason: "not my charge" }),
    RefundConflictError,
  );

  const summaryA = await getBillingSummary("user-a");
  const summaryB = await getBillingSummary("user-b");
  assert.equal(summaryA.balance, FREE_GRANT_CREDITS - USAGE_COSTS["prompt"]!);
  assert.equal(summaryB.balance, FREE_GRANT_CREDITS);
});

test("settleRunUsage refunds the reservation down to the actual token cost and records it as actual", async () => {
  resetBilling();
  await chargeUsage({ userId: "user-a", kind: "prompt", requestId: "req-1" });

  const result = await settleRunUsage({
    userId: "user-a",
    runId: "run-1",
    requestId: "req-1",
    usage: { totalTokens: 500, inputTokens: 300, outputTokens: 200, models: ["gpt-4o-mini"] },
  });

  assert.equal(result.applied, true);
  assert.equal(result.sufficient, true);
  assert.equal(result.finalCredits, 1);

  const summary = await getBillingSummary("user-a");
  assert.equal(summary.balance, FREE_GRANT_CREDITS - 1);

  const page = await listBillingUsage("user-a");
  assert.equal(page.events[0]?.credits, 1);
  assert.equal(page.events[0]?.units, 500);
  assert.equal(page.events[0]?.model, "gpt-4o-mini");
  assert.equal(page.events[0]?.metering, "actual");
});

test("settleRunUsage debits the top-up when actual usage exceeds the reservation", async () => {
  resetBilling();
  await chargeUsage({ userId: "user-a", kind: "prompt", requestId: "req-1" });

  const result = await settleRunUsage({
    userId: "user-a",
    runId: "run-1",
    requestId: "req-1",
    usage: { totalTokens: 24_500, inputTokens: 20_000, outputTokens: 4_500, models: ["gpt-4o"] },
  });

  assert.equal(result.sufficient, true);
  assert.equal(result.finalCredits, 25);
  const summary = await getBillingSummary("user-a");
  assert.equal(summary.balance, FREE_GRANT_CREDITS - 25);
});

test("settleRunUsage without a usage aggregate keeps the fixed reservation and marks it estimated", async () => {
  resetBilling();
  await chargeUsage({ userId: "user-a", kind: "prompt", requestId: "req-1" });

  const result = await settleRunUsage({ userId: "user-a", runId: "run-1", requestId: "req-1" });

  assert.equal(result.sufficient, true);
  assert.equal(result.finalCredits, USAGE_COSTS["prompt"]);
  const summary = await getBillingSummary("user-a");
  assert.equal(summary.balance, FREE_GRANT_CREDITS - USAGE_COSTS["prompt"]!);

  const page = await listBillingUsage("user-a");
  assert.equal(page.events[0]?.metering, "estimated");
});

test("settleRunUsage never overdraws the balance and reports insufficient instead", async () => {
  resetBilling();
  const chargesUntilDrained = Math.floor(FREE_GRANT_CREDITS / USAGE_COSTS["prompt"]!);
  for (let i = 0; i < chargesUntilDrained; i += 1) {
    await chargeUsage({ userId: "user-a", kind: "prompt", requestId: `req-${i}` });
  }
  const lastRequestId = `req-${chargesUntilDrained - 1}`;

  const result = await settleRunUsage({
    userId: "user-a",
    runId: "run-drain",
    requestId: lastRequestId,
    usage: { totalTokens: 999_000, inputTokens: 900_000, outputTokens: 99_000, models: ["gpt-4o"] },
  });

  assert.equal(result.sufficient, false);
  assert.equal(result.finalCredits, USAGE_COSTS["prompt"]);
});

test("settleRunUsage is idempotent: replaying the same runId does not settle twice", async () => {
  resetBilling();
  await chargeUsage({ userId: "user-a", kind: "prompt", requestId: "req-1" });

  const usage = { totalTokens: 24_500, inputTokens: 20_000, outputTokens: 4_500, models: ["gpt-4o"] };
  const first = await settleRunUsage({ userId: "user-a", runId: "run-1", requestId: "req-1", usage });
  const replay = await settleRunUsage({ userId: "user-a", runId: "run-1", requestId: "req-1", usage });

  assert.equal(first.applied, true);
  assert.equal(replay.applied, false);
  const summary = await getBillingSummary("user-a");
  assert.equal(summary.balance, FREE_GRANT_CREDITS - 25);
});

test("refundUsageCharge refuses to refund a reservation whose run was already settled", async () => {
  resetBilling();
  await chargeUsage({ userId: "user-a", kind: "prompt", requestId: "req-1" });
  await settleRunUsage({
    userId: "user-a",
    runId: "run-1",
    requestId: "req-1",
    usage: { totalTokens: 500, inputTokens: 300, outputTokens: 200, models: ["gpt-4o-mini"] },
  });

  await assert.rejects(
    refundUsageCharge({ userId: "user-a", kind: "prompt", requestId: "req-1", runId: "run-1", reason: "run cancelled" }),
    SettlementAlreadyAppliedError,
  );

  const summary = await getBillingSummary("user-a");
  assert.equal(summary.balance, FREE_GRANT_CREDITS - 1);
});

test("chargeUsage rejects replaying a requestId that was already refunded, instead of pretending success", async () => {
  resetBilling();
  await chargeUsage({ userId: "user-a", kind: "prompt", requestId: "req-1" });
  await refundUsageCharge({ userId: "user-a", kind: "prompt", requestId: "req-1", reason: "agent failed" });

  await assert.rejects(
    chargeUsage({ userId: "user-a", kind: "prompt", requestId: "req-1" }),
    PreviousAttemptFailedError,
  );

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

test("chargeUsage keys the idempotency check on kind and session, not requestId alone", async () => {
  resetBilling();
  const promptCharge = await chargeUsage({
    userId: "user-a",
    kind: "prompt",
    sessionId: "session-1",
    requestId: "req-1",
  });
  const editChargeSameRequestId = await chargeUsage({
    userId: "user-a",
    kind: "edit",
    sessionId: "session-1",
    requestId: "req-1",
  });
  const promptChargeOtherSession = await chargeUsage({
    userId: "user-a",
    kind: "prompt",
    sessionId: "session-2",
    requestId: "req-1",
  });

  assert.equal(promptCharge.applied, true);
  assert.equal(editChargeSameRequestId.applied, true);
  assert.equal(promptChargeOtherSession.applied, true);
  assert.notEqual(promptCharge.usageEventId, editChargeSameRequestId.usageEventId);
  assert.notEqual(promptCharge.usageEventId, promptChargeOtherSession.usageEventId);

  const page = await listBillingUsage("user-a");
  assert.equal(page.total, 3);
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
  await assert.rejects(grantDevCredits("user-a", "does-not-matter", "grant-key-1"), DevGrantsDisabledError);
});

test("grantDevCredits rejects package ids the server did not define", async () => {
  resetBilling();
  process.env["BILLING_DEV_GRANTS"] = "true";
  await assert.rejects(
    grantDevCredits("user-a", "not-a-real-package", "grant-key-1"),
    UnknownDevGrantPackageError,
  );
});

test("grantDevCredits adds the server-defined package amount and is exposed in the summary", async () => {
  resetBilling();
  process.env["BILLING_DEV_GRANTS"] = "true";
  const before = await getBillingSummary("user-a");
  const packageId = before.devGrantPackages[0]!.id;
  const packageCredits = before.devGrantPackages[0]!.credits;

  const after = await grantDevCredits("user-a", packageId, "grant-key-1");

  assert.equal(after.balance, before.balance + packageCredits);
});

test("grantDevCredits requires an Idempotency-Key", async () => {
  resetBilling();
  process.env["BILLING_DEV_GRANTS"] = "true";
  const before = await getBillingSummary("user-a");
  const packageId = before.devGrantPackages[0]!.id;

  await assert.rejects(grantDevCredits("user-a", packageId, ""), MissingIdempotencyKeyError);
});

test("grantDevCredits replaying the same Idempotency-Key for the same user and package does not grant twice", async () => {
  resetBilling();
  process.env["BILLING_DEV_GRANTS"] = "true";
  const before = await getBillingSummary("user-a");
  const packageId = before.devGrantPackages[0]!.id;
  const packageCredits = before.devGrantPackages[0]!.credits;

  const first = await grantDevCredits("user-a", packageId, "grant-key-1");
  const replay = await grantDevCredits("user-a", packageId, "grant-key-1");

  assert.equal(first.balance, before.balance + packageCredits);
  assert.equal(replay.balance, first.balance);
});

test("grantDevCredits scopes the same Idempotency-Key to the user and package so it cannot collide across them", async () => {
  resetBilling();
  process.env["BILLING_DEV_GRANTS"] = "true";
  const packageA = DEV_GRANT_PACKAGES[0]!;
  const packageB = DEV_GRANT_PACKAGES[1]!;

  const userAGrant = await grantDevCredits("user-a", packageA.id, "shared-key");
  const userBGrant = await grantDevCredits("user-b", packageA.id, "shared-key");
  const userASecondPackageGrant = await grantDevCredits("user-a", packageB.id, "shared-key");

  assert.equal(userAGrant.balance, FREE_GRANT_CREDITS + packageA.credits);
  assert.equal(userBGrant.balance, FREE_GRANT_CREDITS + packageA.credits);
  assert.equal(userASecondPackageGrant.balance, FREE_GRANT_CREDITS + packageA.credits + packageB.credits);
});
