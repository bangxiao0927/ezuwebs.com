export interface PromptUsageLabelInput {
  metering: "actual" | "estimated";
  units: number;
}

/**
 * "estimated" units are always the reservation's placeholder count, never a
 * measured token total, so they must never be shown as "N tokens".
 */
export function promptUsageLabel(event: PromptUsageLabelInput): string {
  if (event.metering === "estimated") {
    return "token usage unavailable; fixed reservation estimate";
  }
  return `${event.units} tokens`;
}
