import type { AgentEvent } from "@ezu/protocol";

/** Fixed credits reserved at run creation, before actual token usage is known. */
export const RESERVATION_CREDITS = 10;

/** Token granularity a settled credit charge is rounded up to. */
export const CREDITS_PER_TOKEN_BLOCK = 1000;

/** A settled charge is never free, even for a near-zero-token run. */
export const MIN_SETTLED_CREDITS = 1;

/** Pure pricing function: final credits owed for a run's total token usage. */
export function creditsForTokens(totalTokens: number): number {
  if (totalTokens <= 0) {
    return MIN_SETTLED_CREDITS;
  }
  return Math.max(MIN_SETTLED_CREDITS, Math.ceil(totalTokens / CREDITS_PER_TOKEN_BLOCK));
}

export interface ModelUsageTotals {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Distinct model names, in the order they were first seen. */
  models: string[];
}

/** Aggregates every model.usage event in a run's event stream. undefined when the run emitted none. */
export function aggregateModelUsage(events: AgentEvent[]): ModelUsageTotals | undefined {
  const usageEvents = events.filter((event) => event.type === "model.usage");
  if (usageEvents.length === 0) {
    return undefined;
  }

  const models: string[] = [];
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of usageEvents) {
    totalTokens += event.totalTokens;
    inputTokens += event.inputTokens;
    outputTokens += event.outputTokens;
    if (!models.includes(event.model)) {
      models.push(event.model);
    }
  }
  return { totalTokens, inputTokens, outputTokens, models };
}

/** A single model name, an explicit "mixed:" label when several models were used, or undefined for none. */
export function modelLabelFor(models: string[]): string | undefined {
  if (models.length === 0) {
    return undefined;
  }
  if (models.length === 1) {
    return models[0];
  }
  return `mixed:${models.join("+")}`;
}
