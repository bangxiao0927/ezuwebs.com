import assert from "node:assert/strict";
import test from "node:test";

import {
  createSession,
  getSession,
  resolveApproval,
  sendPrompt,
  SessionNotFoundError,
} from "./domain/sessions.js";

test("an unknown session does not reset an existing session", async () => {
  const created = await createSession("club-promo");
  await sendPrompt(created.id, "keep this message");

  await assert.rejects(() => getSession("bogus"), SessionNotFoundError);

  const existing = await getSession(created.id);
  assert.ok(
    existing.viewModel.chatMessages.some((message) => message.content.includes("keep this message")),
  );

  const resumed = await createSession("club-promo");
  assert.ok(
    resumed.viewModel.chatMessages.some((message) => message.content.includes("keep this message")),
  );
});

test("an interaction decision cannot be overwritten", async () => {
  const created = await createSession("agency-redesign");
  assert.equal(created.viewModel.pendingInteraction?.type, "confirm");

  const rejected = await resolveApproval(created.id, "rejected", "Use a simpler layout");
  assert.equal(rejected.viewModel.approvalDecision?.status, "rejected");
  const rejectedPrompt = rejected.viewModel.webEditor.suggestedPrompt;

  const repeated = await resolveApproval(created.id, "approved", "");
  assert.equal(repeated.viewModel.approvalDecision?.status, "rejected");
  assert.equal(repeated.viewModel.webEditor.suggestedPrompt, rejectedPrompt);
});
