import test from "node:test";
import assert from "node:assert/strict";

import { InteractionValidationError, buildChoiceResolutionEvent, buildInputResolutionEvent } from "./interaction.js";

test("buildChoiceResolutionEvent resolves to the matching option and records optionId", () => {
  const interaction = {
    type: "choice" as const,
    id: "interaction-1",
    question: "Which layout do you prefer?",
    options: [
      { id: "opt-a", label: "Sidebar layout" },
      { id: "opt-b", label: "Top nav layout" },
    ],
  };

  const event = buildChoiceResolutionEvent(interaction, "opt-b");

  assert.deepEqual(event, {
    type: "interaction.resolved",
    interactionId: "interaction-1",
    status: "answered",
    title: "Which layout do you prefer?",
    summary: "Selected: Top nav layout",
    optionId: "opt-b",
  });
});

test("buildChoiceResolutionEvent rejects an optionId that is not one of the offered options", () => {
  const interaction = {
    type: "choice" as const,
    id: "interaction-1",
    question: "Which layout do you prefer?",
    options: [{ id: "opt-a", label: "Sidebar layout" }],
  };

  assert.throws(() => buildChoiceResolutionEvent(interaction, "opt-does-not-exist"), InteractionValidationError);
});

test("buildInputResolutionEvent trims the provided value and records it on the event", () => {
  const interaction = {
    type: "input" as const,
    id: "interaction-2",
    label: "What should the new headline say?",
  };

  const event = buildInputResolutionEvent(interaction, "  Build faster teams  ");

  assert.deepEqual(event, {
    type: "interaction.resolved",
    interactionId: "interaction-2",
    status: "answered",
    title: "What should the new headline say?",
    summary: "Provided: Build faster teams",
    value: "Build faster teams",
  });
});

test("buildInputResolutionEvent rejects an empty or whitespace-only value", () => {
  const interaction = {
    type: "input" as const,
    id: "interaction-2",
    label: "What should the new headline say?",
  };

  assert.throws(() => buildInputResolutionEvent(interaction, "   "), InteractionValidationError);
});
