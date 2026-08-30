import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkspacePathError, validateWorkspacePath } from "./path-validation.js";

test("validateWorkspacePath accepts a normal relative path", () => {
  assert.equal(validateWorkspacePath("src/index.ts"), "src/index.ts");
});

test("validateWorkspacePath rejects absolute paths, .. segments, and backslashes", () => {
  assert.throws(() => validateWorkspacePath("/etc/passwd"), WorkspacePathError);
  assert.throws(() => validateWorkspacePath("../secret"), WorkspacePathError);
  assert.throws(() => validateWorkspacePath("a/../b"), WorkspacePathError);
  assert.throws(() => validateWorkspacePath("a\\b"), WorkspacePathError);
});

test("validateWorkspacePath rejects NUL bytes and empty segments", () => {
  assert.throws(() => validateWorkspacePath("a\0b"), WorkspacePathError);
  assert.throws(() => validateWorkspacePath("a//b"), WorkspacePathError);
});

test("validateWorkspacePath allows an empty root only when requested", () => {
  assert.equal(validateWorkspacePath("", { allowEmpty: true }), "");
  assert.throws(() => validateWorkspacePath(""), WorkspacePathError);
});
