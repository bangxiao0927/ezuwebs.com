import assert from "node:assert/strict";
import { test } from "node:test";

import { CommandPolicyError, checkCommandPolicy } from "./command-policy.js";

test("checkCommandPolicy allows an allowlisted executable and subcommand", () => {
  assert.doesNotThrow(() => checkCommandPolicy("frontend-build", ["pnpm", "build"]));
  assert.doesNotThrow(() => checkCommandPolicy("frontend-build", ["npm", "test"]));
  assert.doesNotThrow(() => checkCommandPolicy("frontend-build", ["node", "script.js"]));
});

test("checkCommandPolicy rejects an executable outside the allowlist", () => {
  assert.throws(() => checkCommandPolicy("frontend-build", ["bash", "-c", "echo hi"]), CommandPolicyError);
  assert.throws(() => checkCommandPolicy("frontend-build", ["rm", "-rf", "/"]), CommandPolicyError);
});

test("checkCommandPolicy rejects a subcommand not in the allowlist", () => {
  assert.throws(() => checkCommandPolicy("frontend-build", ["pnpm", "publish"]), CommandPolicyError);
});

test("checkCommandPolicy rejects argv entries containing shell metacharacters or control characters", () => {
  assert.throws(() => checkCommandPolicy("frontend-build", ["pnpm", "build; rm -rf /"]), CommandPolicyError);
  assert.throws(() => checkCommandPolicy("frontend-build", ["pnpm", "build\n"]), CommandPolicyError);
  assert.throws(() => checkCommandPolicy("frontend-build", ["pnpm", "a".repeat(5000)]), CommandPolicyError);
});

test("checkCommandPolicy rejects an unknown policy name", () => {
  assert.throws(() => checkCommandPolicy("unknown-policy", ["pnpm", "build"]), CommandPolicyError);
});
