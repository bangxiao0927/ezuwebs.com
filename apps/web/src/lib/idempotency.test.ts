import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../apiError.js";
import { classifyRequestOutcome, decideIdempotency } from "./idempotency.js";

test("a successful response resets the requestId so the next action mints a fresh one", () => {
  assert.equal(decideIdempotency("success"), "reset");
});

test("a network failure retains the requestId so a retry safely replays the same attempt", () => {
  assert.equal(decideIdempotency("network"), "retain");
});

test("an unknown 5xx response retains the requestId so a retry safely replays the same attempt", () => {
  assert.equal(decideIdempotency({ status: 503 }), "retain");
});

test("a definitive 4xx business error resets the requestId", () => {
  assert.equal(decideIdempotency({ status: 422 }), "reset");
});

test("a 409 conflict from a previously failed attempt resets the requestId so the retry mints a new one", () => {
  assert.equal(decideIdempotency({ status: 409 }), "reset");
});

test("classifyRequestOutcome reports the status carried by an ApiError", () => {
  const outcome = classifyRequestOutcome(new ApiError("Conflict", 409));

  assert.deepEqual(outcome, { status: 409 });
});

test("classifyRequestOutcome treats a plain error as a network failure", () => {
  const outcome = classifyRequestOutcome(new TypeError("Failed to fetch"));

  assert.equal(outcome, "network");
});
