import assert from "node:assert/strict";
import { test } from "node:test";

import { isAuthorized } from "./auth.js";

test("isAuthorized accepts the exact configured bearer token", () => {
  assert.equal(isAuthorized("Bearer correct-token", "correct-token"), true);
});

test("isAuthorized rejects a missing, malformed, or wrong-scheme header", () => {
  assert.equal(isAuthorized(undefined, "correct-token"), false);
  assert.equal(isAuthorized("correct-token", "correct-token"), false);
  assert.equal(isAuthorized("Basic correct-token", "correct-token"), false);
});

test("isAuthorized rejects a wrong token, including a different-length one", () => {
  assert.equal(isAuthorized("Bearer wrong-token", "correct-token"), false);
  assert.equal(isAuthorized("Bearer x", "correct-token"), false);
});
