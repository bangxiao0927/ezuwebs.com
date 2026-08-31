import assert from "node:assert/strict";
import test from "node:test";

import { parseHash } from "./hashRoute.js";

test("an empty hash routes to the launcher home", () => {
  assert.deepEqual(parseHash(""), { name: "launcher" });
});

test("#/select routes to the session select screen", () => {
  assert.deepEqual(parseHash("#/select"), { name: "select" });
});

test("#/session/<id> routes to the session workbench with a decoded id", () => {
  assert.deepEqual(parseHash("#/session/abc%20123"), { name: "session", sessionId: "abc 123" });
});

test("#/dashboard routes to the dashboard", () => {
  assert.deepEqual(parseHash("#/dashboard"), { name: "dashboard" });
});

test("#/credits routes to credits", () => {
  assert.deepEqual(parseHash("#/credits"), { name: "credits" });
});

test("#/usage routes to usage", () => {
  assert.deepEqual(parseHash("#/usage"), { name: "usage" });
});
