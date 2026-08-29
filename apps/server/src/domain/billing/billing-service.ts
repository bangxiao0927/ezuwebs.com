import { createMemoryBillingStore } from "./memory-billing-store.js";
import type { BillingStore, DevGrantPackage, UsageEventDto } from "./store.js";
import { DevGrantsDisabledError, InsufficientCreditsError, UnknownDevGrantPackageError } from "./store.js";

export { DevGrantsDisabledError, InsufficientCreditsError, UnknownDevGrantPackageError };

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

export async function chargeUsage(
  userId: string,
  input: { kind: string; sessionId?: string; model?: string },
): Promise<void> {
  await ensureFreeGrant(userId);
  const credits = USAGE_COSTS[input.kind] ?? 0;
  const result = await billingStore.debitIfSufficient({
    userId,
    credits,
    reason: `usage: ${input.kind}`,
    idempotencyKey: `usage:${crypto.randomUUID()}`,
  });
  if (!result.sufficient) {
    throw new InsufficientCreditsError("Insufficient credits");
  }
  await billingStore.insertUsageEvent({
    userId,
    kind: input.kind,
    units: 1,
    credits,
    ...(input.model ? { model: input.model } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
}
