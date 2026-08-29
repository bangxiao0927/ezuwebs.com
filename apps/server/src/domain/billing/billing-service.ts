import { createMemoryBillingStore } from "./memory-billing-store.js";
import type { BillingStore, DevGrantPackage, UsageEventDto } from "./store.js";
import {
  DevGrantsDisabledError,
  InsufficientCreditsError,
  MissingIdempotencyKeyError,
  UnknownDevGrantPackageError,
} from "./store.js";

export {
  DevGrantsDisabledError,
  InsufficientCreditsError,
  MissingIdempotencyKeyError,
  UnknownDevGrantPackageError,
};

export const FREE_GRANT_CREDITS = 200;

export const USAGE_COSTS: Record<string, number> = {
  prompt: 10,
  edit: 5,
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

export async function grantDevCredits(userId: string, packageId: string): Promise<BillingSummaryDto> {
  if (!isDevGrantsEnabled()) {
    throw new DevGrantsDisabledError("Development credit grants are disabled in this environment");
  }
  const pkg = DEV_GRANT_PACKAGES.find((candidate) => candidate.id === packageId);
  if (!pkg) {
    throw new UnknownDevGrantPackageError(`Unknown dev grant package: ${packageId}`);
  }

  await ensureFreeGrant(userId);
  await billingStore.appendGrant({
    userId,
    amount: pkg.credits,
    reason: `dev grant: ${pkg.label}`,
    idempotencyKey: `dev-grant:${userId}:${packageId}:${crypto.randomUUID()}`,
  });
  const balance = await billingStore.getBalance(userId);
  return { balance, devGrantsEnabled: true, devGrantPackages: DEV_GRANT_PACKAGES };
}

function debitIdempotencyKeyFor(userId: string, requestId: string): string {
  return `usage-debit:${userId}:${requestId}`;
}

function usageEventIdFor(userId: string, requestId: string): string {
  return `usage-event:${userId}:${requestId}`;
}

export interface ChargeUsageInput {
  userId: string;
  kind: string;
  /** Caller-supplied idempotency key; the same requestId must never be charged twice. */
  requestId: string;
  sessionId?: string;
  model?: string;
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
  const debitIdempotencyKey = debitIdempotencyKeyFor(input.userId, input.requestId);
  const result = await billingStore.debitIfSufficient({
    userId: input.userId,
    credits,
    reason: `usage: ${input.kind}`,
    idempotencyKey: debitIdempotencyKey,
  });
  if (!result.sufficient) {
    throw new InsufficientCreditsError("Insufficient credits");
  }
  const usageEventId = usageEventIdFor(input.userId, input.requestId);
  if (!result.applied) {
    return { applied: false, usageEventId, balance: result.balance };
  }
  await billingStore.insertUsageEvent({
    id: usageEventId,
    userId: input.userId,
    kind: input.kind,
    units: 1,
    credits,
    status: "succeeded",
    ...(input.model ? { model: input.model } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
  return { applied: true, usageEventId, balance: result.balance };
}

export interface RefundUsageChargeInput {
  userId: string;
  kind: string;
  requestId: string;
  reason: string;
}

/**
 * Refunds a previously applied chargeUsage debit and marks its usage event
 * refunded. Idempotent: replaying it for the same requestId is a no-op.
 */
export async function refundUsageCharge(input: RefundUsageChargeInput): Promise<void> {
  const credits = USAGE_COSTS[input.kind] ?? 0;
  const debitIdempotencyKey = debitIdempotencyKeyFor(input.userId, input.requestId);
  await billingStore.refundDebit({
    userId: input.userId,
    credits,
    reason: input.reason,
    debitIdempotencyKey,
  });
  await billingStore.markUsageEventRefunded(usageEventIdFor(input.userId, input.requestId));
}
