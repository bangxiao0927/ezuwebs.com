import assert from "node:assert/strict";
import test from "node:test";

import { RemoteRuntimeValidationError } from "./errors.js";
import { validateWorkspacePath } from "./path-validation.js";

test("validateWorkspacePath accepts a plain relative POSIX path", () => {
  assert.equal(validateWorkspacePath("src/App.tsx"), "src/App.tsx");
});

test("validateWorkspacePath allows an empty root path only when explicitly allowed", () => {
  assert.equal(validateWorkspacePath("", { allowEmpty: true }), "");
  assert.throws(() => validateWorkspacePath(""), RemoteRuntimeValidationError);
});

test("validateWorkspacePath rejects an absolute path", () => {
  assert.throws(() => validateWorkspacePath("/etc/passwd"), RemoteRuntimeValidationError);
});

test("validateWorkspacePath rejects a Windows drive-letter absolute path", () => {
  assert.throws(() => validateWorkspacePath("C:/Users/evil"), RemoteRuntimeValidationError);
});

test("validateWorkspacePath rejects path traversal segments", () => {
  assert.throws(() => validateWorkspacePath("../secrets.txt"), RemoteRuntimeValidationError);
  assert.throws(() => validateWorkspacePath("src/../../secrets.txt"), RemoteRuntimeValidationError);
});

test("validateWorkspacePath rejects backslashes", () => {
  assert.throws(() => validateWorkspacePath("src\\App.tsx"), RemoteRuntimeValidationError);
});

test("validateWorkspacePath rejects a NUL byte", () => {
  assert.throws(() => validateWorkspacePath("src/App\0.tsx"), RemoteRuntimeValidationError);
});

test("validateWorkspacePath rejects empty segments from a doubled slash", () => {
  assert.throws(() => validateWorkspacePath("src//App.tsx"), RemoteRuntimeValidationError);
});

test("validateWorkspacePath rejects a path longer than the configured limit", () => {
  const longPath = `src/${"a".repeat(5000)}.tsx`;
  assert.throws(() => validateWorkspacePath(longPath), RemoteRuntimeValidationError);
});
