import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentEvent } from "./index.js";

test("parseAgentEvent accepts a structured execution.error event", () => {
  const event = parseAgentEvent({
    type: "execution.error",
    code: "timeout",
    message: "The command timed out after 30s",
    recoverable: true,
    actionId: "action-1",
  });

  assert.equal(event.type, "execution.error");
});

test("parseAgentEvent accepts execution.error without the optional actionId", () => {
  const event = parseAgentEvent({
    type: "execution.error",
    code: "unknown",
    message: "Something went wrong",
    recoverable: false,
  });

  assert.equal(event.type, "execution.error");
});

test("parseAgentEvent accepts a session.lifecycle event", () => {
  const event = parseAgentEvent({
    type: "session.lifecycle",
    status: "paused",
    reason: "Waiting on user approval",
  });

  assert.equal(event.type, "session.lifecycle");
});

test("parseAgentEvent accepts a model.usage event", () => {
  const event = parseAgentEvent({
    type: "model.usage",
    model: "gpt-4o",
    inputTokens: 120,
    outputTokens: 45,
    totalTokens: 165,
  });

  assert.equal(event.type, "model.usage");
});

test("parseAgentEvent rejects a model.usage event with negative tokens", () => {
  assert.throws(() =>
    parseAgentEvent({
      type: "model.usage",
      model: "gpt-4o",
      inputTokens: -1,
      outputTokens: 0,
      totalTokens: 0,
    }),
  );
});
