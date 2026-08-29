import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryBillingStore } from "./billing/memory-billing-store.js";
import {
  FREE_GRANT_CREDITS,
  MissingIdempotencyKeyError,
  PreviousAttemptFailedError,
  USAGE_COSTS,
  configureBillingStore,
  configureBillingEnabled,
  getBillingSummary,
} from "./billing/billing-service.js";
import { createMemorySessionRepository, type SessionRepository } from "./session-repository.js";
import { applyEdit, configureSessionRepository, createSession, retryAction, sendPrompt } from "./sessions.js";

const USER_ID = "user-a";

function resetBilling(): void {
  configureBillingStore(createMemoryBillingStore());
}

async function markActionFailed(
  repository: SessionRepository,
  sessionId: string,
  actionId: string,
): Promise<void> {
  const record = await repository.get(sessionId);
  if (!record) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  const now = new Date().toISOString();
  record.events.push({
    type: "action.created",
    action: {
      id: actionId,
      source: "coder",
      action: { type: "file.write", path: "src/App.tsx", content: "// retry me" },
      status: "failed",
      error: "boom",
      createdAt: now,
      updatedAt: now,
    },
  });
  await repository.save(record);
}

test("sendPrompt does not charge or require a requestId when billing is disabled, even for a logged-in user", async () => {
  resetBilling();
  configureSessionRepository(createMemorySessionRepository());
  configureBillingEnabled(false);
  try {
    const session = await createSession("club-promo", USER_ID);

    const result = await sendPrompt(session.id, "Make the hero more concise", USER_ID);

    assert.ok(result.viewModel.chatMessages.length > 0);
    const summary = await getBillingSummary(USER_ID);
    assert.equal(summary.balance, FREE_GRANT_CREDITS);
  } finally {
    configureBillingEnabled(true);
  }
});

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

function repositoryWithSaveFailingOnce(): SessionRepository {
  const memory = createMemorySessionRepository();
  let shouldFail = true;
  return {
    ...memory,
    async save(record) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("save failed");
      }
      return memory.save(record);
    },
  };
}

test("sendPrompt refuses a replay of a requestId whose earlier attempt failed and was refunded", async () => {
  resetBilling();
  configureSessionRepository(repositoryWithSaveFailingOnce());
  const session = await createSession("club-promo", USER_ID);

  await assert.rejects(sendPrompt(session.id, "Make the hero more concise", USER_ID, "req-1"));

  await assert.rejects(
    sendPrompt(session.id, "Make the hero more concise", USER_ID, "req-1"),
    PreviousAttemptFailedError,
  );
});

test("retryAction requires a requestId once billing applies", async () => {
  resetBilling();
  const repository = createMemorySessionRepository();
  configureSessionRepository(repository);
  const session = await createSession("club-promo", USER_ID);
  await markActionFailed(repository, session.id, "retry-action-1");

  await assert.rejects(
    retryAction(session.id, "retry-action-1", USER_ID),
    MissingIdempotencyKeyError,
  );

  const summary = await getBillingSummary(USER_ID);
  assert.equal(summary.balance, FREE_GRANT_CREDITS);
});

test("retryAction debits credits on success and does not re-run or debit twice on replay", async () => {
  resetBilling();
  const repository = createMemorySessionRepository();
  configureSessionRepository(repository);
  const session = await createSession("club-promo", USER_ID);
  await markActionFailed(repository, session.id, "retry-action-1");

  const first = await retryAction(session.id, "retry-action-1", USER_ID, "retry-req-1");
  const replay = await retryAction(session.id, "retry-action-1", USER_ID, "retry-req-1");

  assert.equal(replay.viewModel.previews.length, first.viewModel.previews.length);

  const summary = await getBillingSummary(USER_ID);
  assert.equal(summary.balance, FREE_GRANT_CREDITS - USAGE_COSTS["retry"]!);
});

test("retryAction refunds the charge when the action is not actually retryable, instead of charging for nothing", async () => {
  resetBilling();
  const repository = createMemorySessionRepository();
  configureSessionRepository(repository);
  const session = await createSession("club-promo", USER_ID);
  await markActionFailed(repository, session.id, "retry-action-1");
  // Complete it so a subsequent retry attempt is invalid.
  await retryAction(session.id, "retry-action-1", USER_ID, "retry-req-1");

  await assert.rejects(retryAction(session.id, "retry-action-1", USER_ID, "retry-req-2"));

  const summary = await getBillingSummary(USER_ID);
  assert.equal(summary.balance, FREE_GRANT_CREDITS - USAGE_COSTS["retry"]!);
});

test("retryAction refunds the charge when saving the session fails", async () => {
  resetBilling();
  const repository = createMemorySessionRepository();
  let shouldFailSave = false;
  const failingRepository: SessionRepository = {
    ...repository,
    async save(record) {
      if (shouldFailSave) {
        throw new Error("save failed");
      }
      return repository.save(record);
    },
  };
  configureSessionRepository(failingRepository);
  const session = await createSession("club-promo", USER_ID);
  await markActionFailed(repository, session.id, "retry-action-1");

  shouldFailSave = true;
  await assert.rejects(retryAction(session.id, "retry-action-1", USER_ID, "retry-req-1"));

  const summary = await getBillingSummary(USER_ID);
  assert.equal(summary.balance, FREE_GRANT_CREDITS);
});
