import { type AgentEvent, type PendingInteraction } from "@ezu/protocol";

export class InteractionValidationError extends Error {}

export function buildChoiceResolutionEvent(
  interaction: Extract<PendingInteraction, { type: "choice" }>,
  optionId: string,
): AgentEvent {
  const option = interaction.options.find((candidate) => candidate.id === optionId);
  if (!option) {
    throw new InteractionValidationError("optionId must match one of the interaction options");
  }

  return {
    type: "interaction.resolved",
    interactionId: interaction.id,
    status: "answered",
    title: interaction.question,
    summary: `Selected: ${option.label}`,
    optionId: option.id,
  };
}

export function buildInputResolutionEvent(
  interaction: Extract<PendingInteraction, { type: "input" }>,
  value: string,
): AgentEvent {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new InteractionValidationError("value must not be empty");
  }

  return {
    type: "interaction.resolved",
    interactionId: interaction.id,
    status: "answered",
    title: interaction.label,
    summary: `Provided: ${trimmed}`,
    value: trimmed,
  };
}
