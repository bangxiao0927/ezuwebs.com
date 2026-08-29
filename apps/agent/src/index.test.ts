import test from "node:test";
import assert from "node:assert/strict";

import { executeApprovedBlockEdit, bootstrapBlockEditDemo } from "./index.js";
import {
  createReplacementStructurePatch,
  inferStructuralChanges,
  normalizeReason,
  type ReplacementPatchInput,
} from "./replacement.js";

function createOptions(rejectionReason: string): ReplacementPatchInput {
  return {
    blockId: "hero",
    targetPath: "apps/web/src/index.ts",
    suggestedPrompt: "Replace the hero block from scratch.",
    rejectedPatch: "// old patch\nconst previous = true;",
    rejectionReason,
  };
}

test("normalizeReason trims and collapses whitespace", () => {
  assert.equal(normalizeReason("  layout   is \n unclear  "), "layout is unclear");
});

test("inferStructuralChanges reacts to layout-related rejection reasons", () => {
  assert.deepEqual(inferStructuralChanges("layout hierarchy is wrong"), [
    "Rebuild the block hierarchy instead of tweaking labels in place.",
  ]);
});

test("createReplacementStructurePatch changes output based on rejection reason", () => {
  const layoutPatch = createReplacementStructurePatch(createOptions("layout hierarchy is wrong"), "gpt-test");
  const copyPatch = createReplacementStructurePatch(createOptions("copy is too generic"), "gpt-test");

  assert.notEqual(layoutPatch, copyPatch);
  assert.match(layoutPatch, /id: "decisionPanel"/);
  assert.match(layoutPatch, /Promote structure changes ahead of wording changes\./);
  assert.match(layoutPatch, /export function renderReplacementStructure\(\)/);
  assert.match(copyPatch, /id: "messageStrip"/);
  assert.match(copyPatch, /Rewrite visible strings so the replacement explains the intended action more directly\./);
  assert.match(copyPatch, /<section class=\\"replacement-messageStrip\\">MessageStrip<\/section>/);
});

test("createReplacementStructurePatch handles empty rejection reason gracefully", () => {
  const patch = createReplacementStructurePatch(createOptions(""), "gpt-test");

  assert.match(patch, /blockId: 'hero'/);
  assert.match(patch, /strategy: 'replace_structure'/);
  assert.match(patch, /Restructure the block around the rejection reason/);
});

test("bootstrapBlockEditDemo stops before running the patch action so approval gates execution", async () => {
  const events = await bootstrapBlockEditDemo({
    sessionId: "gating-session",
    projectId: "gating-project",
    blockId: "hero",
    targetPath: "apps/web/src/index.ts",
    suggestedPrompt: "Refine the hero block copy.",
  });

  const interactionRequired = events.find((event) => event.type === "interaction.required");
  assert.ok(interactionRequired && interactionRequired.type === "interaction.required");
  assert.equal(interactionRequired.interaction.type, "confirm");
  const actionId = interactionRequired.interaction.type === "confirm" ? interactionRequired.interaction.actionId : undefined;
  assert.ok(actionId, "confirm interaction should reference the gated action");

  const createdAction = events.find(
    (event) => event.type === "action.created" && event.action.id === actionId,
  );
  assert.ok(createdAction && createdAction.type === "action.created");
  assert.equal(createdAction.action.status, "pending");

  const executedBeforeApproval = events.some(
    (event) => event.type === "action.updated" && event.action.id === actionId,
  );
  assert.equal(executedBeforeApproval, false, "the gated action must not run before approval");

  const previewCreatedBeforeApproval = events.some(
    (event) => event.type === "action.created" && event.action.action.type === "preview.open",
  );
  assert.equal(previewCreatedBeforeApproval, false, "preview must not open before approval");
});

test("executeApprovedBlockEdit runs the approved action exactly once and opens a preview", async () => {
  const events = await bootstrapBlockEditDemo({
    sessionId: "gating-session-2",
    projectId: "gating-project-2",
    blockId: "hero",
    targetPath: "apps/web/src/index.ts",
    suggestedPrompt: "Refine the hero block copy.",
  });

  const createdAction = events.find(
    (event) => event.type === "action.created" && event.action.action.type === "file.patch",
  );
  assert.ok(createdAction && createdAction.type === "action.created");

  const execution = await executeApprovedBlockEdit({
    sessionId: "gating-session-2",
    projectId: "gating-project-2",
    action: createdAction.action,
  });

  const updates = execution.events.filter(
    (event) => event.type === "action.updated" && event.action.id === createdAction.action.id,
  );
  assert.equal(updates.length, 1, "the approved action should run exactly once");
  assert.ok(updates[0]?.type === "action.updated" && updates[0].action.status === "completed");

  const previewReady = execution.events.some((event) => event.type === "preview.ready");
  assert.ok(previewReady, "approval should open a preview after execution");
});

test("executeApprovedBlockEdit seeds the runtime with the session's existing workspace files", async () => {
  const events = await bootstrapBlockEditDemo({
    sessionId: "seed-session",
    projectId: "seed-project",
    blockId: "hero",
    targetPath: "src/App.tsx",
    suggestedPrompt: "Refine the hero block copy.",
  });
  const createdAction = events.find(
    (event) => event.type === "action.created" && event.action.action.type === "file.patch",
  );
  assert.ok(createdAction && createdAction.type === "action.created");

  const execution = await executeApprovedBlockEdit({
    sessionId: "seed-session",
    projectId: "seed-project",
    action: createdAction.action,
    workspaceFiles: [{ path: "README.md", content: "# Existing project" }],
  });

  const readme = execution.workspaceFiles.find((file) => file.path === "README.md");
  assert.ok(readme, "pre-existing workspace files should still be present after execution");
  assert.equal(readme?.content, "# Existing project");

  const patchedFile = execution.workspaceFiles.find((file) => file.path === "src/App.tsx");
  assert.ok(patchedFile, "the successfully patched file should be synced back into workspace files");
});
