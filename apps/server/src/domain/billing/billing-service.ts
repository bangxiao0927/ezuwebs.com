import { createMemoryBillingStore } from "./memory-billing-store.js";
import type { BillingStore, DevGrantPackage, UsageEventDto } from "./store.js";
import {
  DevGrantsDisabledError,
  InsufficientCreditsError,
  MissingIdempotencyKeyError,
  PreviousAttemptFailedError,
  RefundConflictError,
  UnknownDevGrantPackageError,
} from "./store.js";
import { RESERVATION_CREDITS, creditsForTokens, modelLabelFor, type ModelUsageTotals } from "./pricing.js";

export {
  DevGrantsDisabledError,
  InsufficientCreditsError,
  MissingIdempotencyKeyError,
  PreviousAttemptFailedError,
  RefundConflictError,
  UnknownDevGrantPackageError,
};

export const FREE_GRANT_CREDITS = 200;

export const USAGE_COSTS: Record<string, number> = {
  prompt: RESERVATION_CREDITS,
  edit: 5,
  retry: 5,
};

/** Fixed, server-defined credit amounts. Never accept a client-supplied amount. */
export const DEV_GRANT_PACKAGES: DevGrantPackage[] = [
  { id: "dev-small", label: "Development credits - small", credits: 100 },
  { id: "dev-large", label: "Development credits - large", credits: 500 },
];

const DEFAULT_USAGE_PAGE_LIMIT = 20;
const MAX_USAGE_PAGE_LIMIT = 100;

let billingStore: BillingStore = createMemoryBillingStore();

export function configureBillingStore(store: BillingStore): void {
  billingStore = store;
}

// Whether prompt/edit routes must resolve an authenticated user before running
// billed agent actions. Tests and demo-only setups can turn this off via
// configureBillingEnabled to keep anonymous flows working without a store.
let billingEnabled = true;

export function configureBillingEnabled(enabled: boolean): void {
  billingEnabled = enabled;
}

export function isBillingEnabled(): boolean {
  return billingEnabled;
}

function isDevGrantsEnabled(): boolean {
  return process.env["BILLING_DEV_GRANTS"] === "true";
}

function availableDevGrantPackages(): DevGrantPackage[] {
  return isDevGrantsEnabled() ? DEV_GRANT_PACKAGES : [];
}

export interface BillingSummaryDto {
  balance: number;
  devGrantsEnabled: boolean;
  devGrantPackages: DevGrantPackage[];
}

export interface UsagePageDto {
  events: UsageEventDto[];
  total: number;
  totalCreditsConsumed: number;
  limit: number;
  offset: number;
}

async function ensureFreeGrant(userId: string): Promise<void> {
  await billingStore.appendGrant({
    userId,
    amount: FREE_GRANT_CREDITS,
    reason: "initial free grant",
    idempotencyKey: `initial-grant:${userId}`,
  });
}

export async function getBillingSummary(userId: string): Promise<BillingSummaryDto> {
  await ensureFreeGrant(userId);
  const balance = await billingStore.getBalance(userId);
  return {
    balance,
    devGrantsEnabled: isDevGrantsEnabled(),
    devGrantPackages: availableDevGrantPackages(),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export async function listBillingUsage(
  userId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<UsagePageDto> {
  const limit = clamp(options.limit ?? DEFAULT_USAGE_PAGE_LIMIT, 1, MAX_USAGE_PAGE_LIMIT);
  const offset = clamp(options.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
  const { events, total, totalCreditsConsumed } = await billingStore.listUsageEvents(userId, {
    limit,
    offset,
  });
  return { events, total, totalCreditsConsumed, limit, offset };
}

export async function grantDevCredits(
  userId: string,
  packageId: string,
  idempotencyKey: string,
): Promise<BillingSummaryDto> {
  if (!isDevGrantsEnabled()) {
    throw new DevGrantsDisabledError("Development credit grants are disabled in this environment");
  }
  const pkg = DEV_GRANT_PACKAGES.find((candidate) => candidate.id === packageId);
  if (!pkg) {
    throw new UnknownDevGrantPackageError(`Unknown dev grant package: ${packageId}`);
  }
  if (!idempotencyKey) {
    throw new MissingIdempotencyKeyError("An Idempotency-Key is required to grant dev credits");
  }

  await ensureFreeGrant(userId);
  await billingStore.appendGrant({
    userId,
    amount: pkg.credits,
    reason: `dev grant: ${pkg.label}`,
    idempotencyKey: `dev-grant:${userId}:${packageId}:${idempotencyKey}`,
  });
  const balance = await billingStore.getBalance(userId);
  return { balance, devGrantsEnabled: true, devGrantPackages: DEV_GRANT_PACKAGES };
}

interface UsageChargeKeyInput {
  userId: string;
  kind: string;
  sessionId?: string;
  requestId: string;
}

/**
 * Includes kind and sessionId alongside userId+requestId so a requestId
 * reused across kinds or sessions (a client bug, not a legitimate replay)
 * cannot collide with an unrelated charge.
 */
function debitIdempotencyKeyFor(input: UsageChargeKeyInput): string {
  return `usage-debit:${input.userId}:${input.kind}:${input.sessionId ?? "-"}:${input.requestId}`;
}

function usageEventIdFor(input: UsageChargeKeyInput): string {
  return `usage-event:${input.userId}:${input.kind}:${input.sessionId ?? "-"}:${input.requestId}`;
}

export interface ChargeUsageInput {
  userId: string;
  kind: string;
  /** Caller-supplied idempotency key; the same requestId must never be charged twice. */
  requestId: string;
  sessionId?: string;
  model?: string;
  /**
   * "estimated" marks a reservation pending settleRunUsage (e.g. an agent
   * run's prompt charge); "actual" (the default) is a flat, known-final
   * charge that never gets reconciled later.
   */
  metering?: "actual" | "estimated";
}

export interface ChargeUsageResult {
  /** False when requestId was already charged; the caller should not re-run the billed action. */
  applied: boolean;
  usageEventId: string;
  balance: number;
}

export async function chargeUsage(input: ChargeUsageInput): Promise<ChargeUsageResult> {
  if (!input.requestId) {
    throw new MissingIdempotencyKeyError("A requestId is required to charge usage");
  }
  await ensureFreeGrant(input.userId);
  const credits = USAGE_COSTS[input.kind] ?? 0;
  const debitIdempotencyKey = debitIdempotencyKeyFor(input);
  const usageEventId = usageEventIdFor(input);
  const result = await billingStore.debitAndRecordUsage({
    userId: input.userId,
    credits,
    debitReason: `usage: ${input.kind}`,
    debitIdempotencyKey,
    usageEvent: {
      id: usageEventId,
      userId: input.userId,
      kind: input.kind,
      units: 1,
      credits,
      status: "succeeded",
      metering: input.metering ?? "actual",
      ...(input.model ? { model: input.model } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    },
  });
  if (!result.sufficient) {
    throw new InsufficientCreditsError("Insufficient credits");
  }
  if (!result.applied) {
    const priorStatus = await billingStore.getUsageEventStatus(usageEventId);
    if (priorStatus === "refunded") {
      throw new PreviousAttemptFailedError(
        "A previous attempt for this requestId failed and was refunded; retry with a new requestId",
      );
    }
    return { applied: false, usageEventId, balance: result.balance };
  }
  return { applied: true, usageEventId, balance: result.balance };
}

export interface RefundUsageChargeInput {
  userId: string;
  kind: string;
  sessionId?: string;
  requestId: string;
  reason: string;
  /**
   * The run this charge was reserved for. When given, the refund is refused
   * once a settlement is recorded for that run: settleRunUsage has already
   * reconciled the reservation, so a full refund on top of it would credit
   * the user twice.
   */
  runId?: string;
}

/** A settlement for the refund's runId was already recorded; refusing to also refund the full reservation. */
export class SettlementAlreadyAppliedError extends Error {}

/**
 * Refunds a previously applied chargeUsage debit and marks its usage event
 * refunded. Idempotent: replaying it for the same requestId is a no-op.
 * Throws RefundConflictError when no matching charge for this requestId was
 * ever recorded, so a refund can never manufacture new credits.
 */
export async function refundUsageCharge(input: RefundUsageChargeInput): Promise<void> {
  if (input.runId) {
    const settlement = await billingStore.getSettlement(input.runId);
    if (settlement) {
      throw new SettlementAlreadyAppliedError(
        `Run ${input.runId} was already settled; refusing to also refund its reservation`,
      );
    }
  }
  const credits = USAGE_COSTS[input.kind] ?? 0;
  const debitIdempotencyKey = debitIdempotencyKeyFor(input);
  const usageEventId = usageEventIdFor(input);
  const status = await billingStore.getUsageEventStatus(usageEventId);
  if (status === undefined) {
    throw new RefundConflictError(
      "No matching charge exists for this requestId; refusing to credit an unverified refund",
    );
  }
  if (status === "refunded") {
    return;
  }
  await billingStore.refundDebit({
    userId: input.userId,
    credits,
    reason: input.reason,
    debitIdempotencyKey,
  });
  await billingStore.markUsageEventRefunded(usageEventId);
}

export interface SettleRunUsageInput {
  userId: string;
  /** The run being settled; also the settlement's idempotency key. */
  runId: string;
  sessionId?: string;
  /** The requestId chargeUsage originally reserved credits against. */
  requestId: string;
  /** Aggregated model.usage totals for the run; undefined when the run never reported real usage. */
  usage?: ModelUsageTotals;
}

export interface SettleRunUsageResult {
  /** False when this runId was already settled (idempotent replay). */
  applied: boolean;
  /** False when actual usage exceeded the reservation and the balance could not cover the top-up. */
  sufficient: boolean;
  balance: number;
  finalCredits: number;
}

/**
 * Reconciles a run's fixed "prompt" reservation against its actual model
 * usage: refunds the difference when usage came in under the reservation,
 * debits the difference when it exceeded it, and never overdraws the
 * balance. A run with no reported usage (e.g. a stub gateway) keeps the
 * reservation as-is and is recorded as "estimated", never "actual".
 */
export async function settleRunUsage(input: SettleRunUsageInput): Promise<SettleRunUsageResult> {
  const reservedCredits = USAGE_COSTS["prompt"] ?? RESERVATION_CREDITS;
  const keyInput: UsageChargeKeyInput = {
    userId: input.userId,
    kind: "prompt",
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    requestId: input.requestId,
  };
  const usageEventId = usageEventIdFor(keyInput);

  const finalCredits = input.usage ? creditsForTokens(input.usage.totalTokens) : reservedCredits;
  const metering = input.usage ? "actual" : "estimated";
  const model = input.usage ? modelLabelFor(input.usage.models) : undefined;
  const units = input.usage ? input.usage.totalTokens : undefined;

  return billingStore.settleUsage({
    userId: input.userId,
    runId: input.runId,
    usageEventId,
    reservedCredits,
    finalCredits,
    metering,
    reason: "usage settlement: prompt",
    ...(units !== undefined ? { units } : {}),
    ...(model !== undefined ? { model } : {}),
  });
}
