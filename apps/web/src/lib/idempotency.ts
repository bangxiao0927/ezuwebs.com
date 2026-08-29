import { ApiError } from "../apiError";

export type RequestOutcome = "success" | "network" | { status: number };

export type IdempotencyDecision = "retain" | "reset";

/**
 * Decides whether the requestId used for a retried write must be reused
 * (safe replay of an in-flight or unknown-result attempt) or discarded so
 * the next attempt mints a fresh one (the previous attempt is known to be
 * finished, successfully or not).
 */
export function decideIdempotency(outcome: RequestOutcome): IdempotencyDecision {
  if (outcome === "success") {
    return "reset";
  }
  if (outcome === "network") {
    return "retain";
  }
  // An HTTP response is a definitive server outcome. Only a transport failure
  // leaves the result unknown and therefore requires replaying the same key.
  return "reset";
}

export function classifyRequestOutcome(error: unknown): RequestOutcome {
  if (error instanceof ApiError) {
    return { status: error.status };
  }
  return "network";
}
