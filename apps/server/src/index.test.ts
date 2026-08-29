import test from "node:test";
import assert from "node:assert/strict";

import { createReplacementPrompt } from "./domain/replacement.js";
import {
  createSession,
  getSession,
  InteractionConflictError,
  resolveApproval,
  sendPrompt,
} from "./domain/sessions.js";
import {
  createInteractiveWebEditResponse,
  createWorkbenchViewModel,
} from "./domain/view-model.js";

test("createReplacementPrompt injects rejection reason and replacement constraints", () => {
  const prompt = createReplacementPrompt(
    "Update page block hero at main > header.topbar.",
    "layout hierarchy is confusing",
  );

  assert.match(prompt, /Rejected because: layout hierarchy is confusing\./);
  assert.match(prompt, /Redo the patch from scratch based on that rejection reason\./);
  assert.match(prompt, /Do not reuse the previous structure if it conflicts with the rejection reason\./);
});

test("createWorkbenchViewModel reduces events into a renderable view model", () => {
  const response = createInteractiveWebEditResponse({
    selection: { blockId: "workbench", path: "apps/web/src/main.ts" },
    intent: "Tighten the workbench layout",
    patchStrategy: "refine",
  });

  const viewModel = createWorkbenchViewModel({
    config: { projectName: "Test", runtimeType: "browser" },
    initialEvents: [
      { type: "message.delta", messageId: "m1", text: "Hello" },
      { type: "message.completed", messageId: "m1" },
    ],
    sessionId: "test-session",
    projectId: "test-project",
    webEditor: response.nextState,
  });

  assert.equal(viewModel.chatMessages.length, 1);
  assert.equal(viewModel.chatMessages[0]?.content, "Hello");
  assert.ok(viewModel.webEditor.blocks.length >= 1);
});

test("sessions survive reloads and prompts run through the agent workflow", async () => {
  const created = await createSession("club-promo");
  const beforeCount = created.viewModel.chatMessages.length;

  const updated = await sendPrompt(created.id, "Make the hero more concise");
  const reloaded = await getSession(created.id);

  assert.equal(reloaded.id, created.id);
  assert.equal(reloaded.viewModel.chatMessages.length, updated.viewModel.chatMessages.length);
  assert.ok(reloaded.viewModel.chatMessages.length > beforeCount);
  assert.ok(
    reloaded.viewModel.chatMessages.some(
      (message) => message.role === "user" && message.content === "Make the hero more concise",
    ),
  );
  assert.ok(reloaded.viewModel.actions.length > created.viewModel.actions.length);
});

test("an interaction cannot be resolved twice", async () => {
  const created = await createSession("agency-redesign");
  const interactionId = created.viewModel.pendingInteraction?.id;
  assert.ok(interactionId);

  await resolveApproval(created.id, interactionId, "approved", "Approved");
  await assert.rejects(
    resolveApproval(created.id, interactionId, "approved", "Approved again"),
    InteractionConflictError,
  );
});
