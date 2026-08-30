import assert from "node:assert/strict";
import test from "node:test";

import { applyRunEvent, createRunStreamState } from "./runStream.js";

test("a message.delta event for a new messageId starts a streaming message", () => {
  const state = createRunStreamState();

  const next = applyRunEvent(state, { type: "message.delta", messageId: "m1", text: "Hel", role: "assistant" });

  assert.deepEqual(next.messages, [{ id: "m1", role: "assistant", text: "Hel", complete: false }]);
});

test("a second message.delta for the same messageId appends its text", () => {
  let state = createRunStreamState();
  state = applyRunEvent(state, { type: "message.delta", messageId: "m1", text: "Hel", role: "assistant" });

  state = applyRunEvent(state, { type: "message.delta", messageId: "m1", text: "lo" });

  assert.deepEqual(state.messages, [{ id: "m1", role: "assistant", text: "Hello", complete: false }]);
});

test("message.completed marks the matching message complete without changing its text", () => {
  let state = createRunStreamState();
  state = applyRunEvent(state, { type: "message.delta", messageId: "m1", text: "Hello", role: "assistant" });

  state = applyRunEvent(state, { type: "message.completed", messageId: "m1" });

  assert.deepEqual(state.messages, [{ id: "m1", role: "assistant", text: "Hello", complete: true }]);
});

test("a message.delta with no role defaults to assistant", () => {
  const state = applyRunEvent(createRunStreamState(), { type: "message.delta", messageId: "m1", text: "hi" });

  assert.equal(state.messages[0]?.role, "assistant");
});

test("any other event type flags that a session refresh is needed, without touching messages", () => {
  const state = applyRunEvent(createRunStreamState(), { type: "plan.updated", plan: [] });

  assert.equal(state.needsRefresh, true);
  assert.deepEqual(state.messages, []);
});
