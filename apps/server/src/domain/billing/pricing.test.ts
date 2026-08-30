import test from "node:test";
import assert from "node:assert/strict";

import type { AgentEvent } from "@ezu/protocol";

import { RESERVATION_CREDITS, aggregateModelUsage, creditsForTokens, modelLabelFor } from "./pricing.js";

test("creditsForTokens rounds up to the nearest 1000-token block, with a floor of 1 credit", () => {
  assert.equal(creditsForTokens(0), 1);
  assert.equal(creditsForTokens(1), 1);
  assert.equal(creditsForTokens(1000), 1);
  assert.equal(creditsForTokens(1001), 2);
  assert.equal(creditsForTokens(15234), 16);
});

test("creditsForTokens never charges less than the reservation for a request within its budget", () => {
  // 10 reserved credits cover up to 10_000 tokens before an over-budget request needs a top-up debit.
  assert.equal(creditsForTokens(10_000), RESERVATION_CREDITS);
  assert.equal(creditsForTokens(10_001), RESERVATION_CREDITS + 1);
});

test("aggregateModelUsage sums tokens across every model.usage event and lists distinct models in order", () => {
  const events: AgentEvent[] = [
    { type: "message.delta", messageId: "m1", text: "hi" },
    { type: "model.usage", model: "gpt-4o-mini", inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    { type: "model.usage", model: "gpt-4o", inputTokens: 200, outputTokens: 100, totalTokens: 300 },
    { type: "model.usage", model: "gpt-4o-mini", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  ];

  const totals = aggregateModelUsage(events);

  assert.ok(totals);
  assert.equal(totals?.totalTokens, 465);
  assert.equal(totals?.inputTokens, 310);
  assert.equal(totals?.outputTokens, 155);
  assert.deepEqual(totals?.models, ["gpt-4o-mini", "gpt-4o"]);
});

test("aggregateModelUsage returns undefined when no model.usage event was emitted", () => {
  const events: AgentEvent[] = [{ type: "message.delta", messageId: "m1", text: "hi" }];
  assert.equal(aggregateModelUsage(events), undefined);
});

test("modelLabelFor returns the single model name, a mixed label for several, and undefined for none", () => {
  assert.equal(modelLabelFor(["gpt-4o"]), "gpt-4o");
  assert.equal(modelLabelFor(["gpt-4o-mini", "gpt-4o"]), "mixed:gpt-4o-mini+gpt-4o");
  assert.equal(modelLabelFor([]), undefined);
});
