import { type AgentAction, type ErrorCategory } from "@ezu/protocol";

export type RecoveryStrategy =
  | "retry_same"
  | "retry_with_reduced_output"
  | "pause_for_user"
  | "abort";

export interface RecoveryPolicyInput {
  category: ErrorCategory;
  /** Number of attempts already made, including the one that just failed. */
  attemptsMade: number;
  actionType: AgentAction["type"];
  recoverable?: boolean;
}

export interface RecoveryDecision {
  strategy: RecoveryStrategy;
  reason: string;
}

const SIDE_EFFECTING_ACTION_TYPES: ReadonlySet<AgentAction["type"]> = new Set([
  "file.patch",
  "command.run",
]);

const MAX_AUTOMATIC_RETRIES = 1;

export function decideRecovery(input: RecoveryPolicyInput): RecoveryDecision {
  if (input.recoverable === false) {
    return { strategy: "abort", reason: "The error was reported as unrecoverable." };
  }

  if (SIDE_EFFECTING_ACTION_TYPES.has(input.actionType)) {
    return {
      strategy: "pause_for_user",
      reason: "Side-effecting actions are never retried automatically.",
    };
  }

  if (input.attemptsMade > MAX_AUTOMATIC_RETRIES) {
    return {
      strategy: "pause_for_user",
      reason: "The automatic retry budget for this action has been used.",
    };
  }

  switch (input.category) {
    case "timeout":
    case "network":
      return { strategy: "retry_same", reason: "Transient error, retrying the same input." };
    case "structured_output":
    case "token_limit":
      return {
        strategy: "retry_with_reduced_output",
        reason: "The model output was too large or malformed; retrying with reduced output.",
      };
    case "conflict":
      return { strategy: "pause_for_user", reason: "Conflicting state requires a user decision." };
    case "permission":
      return { strategy: "pause_for_user", reason: "Permission must be granted by a user." };
    case "command_failed":
      return { strategy: "pause_for_user", reason: "A failed command requires a user decision." };
    case "unknown":
    default:
      return { strategy: "pause_for_user", reason: "The error category is unknown; deferring to a user." };
  }
}
