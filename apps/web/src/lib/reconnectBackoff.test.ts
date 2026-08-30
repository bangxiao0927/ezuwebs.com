import assert from "node:assert/strict";
import test from "node:test";

import { reconnectDelayMs } from "./reconnectBackoff.js";

test("the first reconnect attempt waits the base delay", () => {
  assert.equal(reconnectDelayMs(1, 500, 10_000), 500);
});

test("each subsequent attempt doubles the previous delay", () => {
  assert.equal(reconnectDelayMs(2, 500, 10_000), 1000);
  assert.equal(reconnectDelayMs(3, 500, 10_000), 2000);
});

test("the delay never exceeds the configured cap", () => {
  assert.equal(reconnectDelayMs(10, 500, 10_000), 10_000);
});
