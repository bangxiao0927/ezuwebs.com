import assert from "node:assert/strict";
import test from "node:test";

import { decideRecovery } from "./recovery.js";

test("a transient network failure on a non side-effecting action retries with the same input on the first attempt", () => {
  const decision = decideRecovery({
    category: "network",
    attemptsMade: 1,
    actionType: "interaction.confirm",
  });

  assert.equal(decision.strategy, "retry_same");
});

test("structured output errors retry with reduced output on the first attempt", () => {
  const decision = decideRecovery({
    category: "structured_output",
    attemptsMade: 1,
    actionType: "interaction.confirm",
  });

  assert.equal(decision.strategy, "retry_with_reduced_output");
});

test("automatic retries are capped at one attempt", () => {
  const decision = decideRecovery({
    category: "network",
    attemptsMade: 2,
    actionType: "interaction.confirm",
  });

  assert.equal(decision.strategy, "pause_for_user");
});

test("a side-effecting file.patch action never auto-retries, even on the first failure", () => {
  const decision = decideRecovery({
    category: "timeout",
    attemptsMade: 1,
    actionType: "file.patch",
  });

  assert.equal(decision.strategy, "pause_for_user");
});

test("a side-effecting command.run action never auto-retries, even on the first failure", () => {
  const decision = decideRecovery({
    category: "network",
    attemptsMade: 1,
    actionType: "command.run",
  });

  assert.equal(decision.strategy, "pause_for_user");
});

test("permission errors always require the user, regardless of attempt count", () => {
  const decision = decideRecovery({
    category: "permission",
    attemptsMade: 1,
    actionType: "interaction.confirm",
  });

  assert.equal(decision.strategy, "pause_for_user");
});

test("conflict errors always require the user", () => {
  const decision = decideRecovery({
    category: "conflict",
    attemptsMade: 1,
    actionType: "interaction.confirm",
  });

  assert.equal(decision.strategy, "pause_for_user");
});

test("an explicitly unrecoverable error aborts regardless of category", () => {
  const decision = decideRecovery({
    category: "network",
    attemptsMade: 1,
    actionType: "interaction.confirm",
    recoverable: false,
  });

  assert.equal(decision.strategy, "abort");
});

test("an unknown error category is conservative and pauses for the user", () => {
  const decision = decideRecovery({
    category: "unknown",
    attemptsMade: 1,
    actionType: "interaction.confirm",
  });

  assert.equal(decision.strategy, "pause_for_user");
});
