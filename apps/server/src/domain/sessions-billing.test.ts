import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryBillingStore } from "./billing/memory-billing-store.js";
import {
  FREE_GRANT_CREDITS,
  USAGE_COSTS,
  configureBillingStore,
  getBillingSummary,
} from "./billing/billing-service.js";
import { createMemorySessionRepository, type SessionRepository } from "./session-repository.js";
import { applyEdit, configureSessionRepository, createSession, sendPrompt } from "./sessions.js";

const USER_ID = "user-a";

function resetBilling(): void {
  configureBillingStore(createMemoryBillingStore());
}

function repositoryWithFailingSave(): SessionRepository {
  const memory = createMemorySessionRepository();
  return {
    ...memory,
    async save() {
      throw new Error("save failed");
    },
  };
}

test("sendPrompt refunds the charge when saving the session fails", async () => {
  resetBilling();
  configureSessionRepository(repositoryWithFailingSave());
  const session = await createSession("club-promo", USER_ID);

  await assert.rejects(sendPrompt(session.id, "Make the hero more concise", USER_ID, "req-1"));

  const summary = await getBillingSummary(USER_ID);
  assert.equal(summary.balance, FREE_GRANT_CREDITS);
});

test("applyEdit refunds the charge when saving the session fails", async () => {
  resetBilling();
  configureSessionRepository(repositoryWithFailingSave());
  const session = await createSession("club-promo", USER_ID);

  await assert.rejects(
    applyEdit(
      session.id,
      { intent: "Tighten the copy", patchStrategy: "refine", requestId: "req-1" },
      USER_ID,
    ),
  );

  const summary = await getBillingSummary(USER_ID);
  assert.equal(summary.balance, FREE_GRANT_CREDITS);
});

test("sendPrompt does not re-run the agent or debit twice when replaying the same requestId", async () => {
  resetBilling();
  configureSessionRepository(createMemorySessionRepository());
  const session = await createSession("club-promo", USER_ID);

  const first = await sendPrompt(session.id, "Make the hero more concise", USER_ID, "req-1");
  const replay = await sendPrompt(session.id, "Make the hero more concise", USER_ID, "req-1");

  assert.equal(replay.viewModel.chatMessages.length, first.viewModel.chatMessages.length);

  const summary = await getBillingSummary(USER_ID);
  assert.equal(summary.balance, FREE_GRANT_CREDITS - USAGE_COSTS["prompt"]!);
});
