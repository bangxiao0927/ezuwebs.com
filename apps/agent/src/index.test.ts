import test from "node:test";
import assert from "node:assert/strict";

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
