export type LedgerEntryType = "grant" | "debit" | "refund";

export interface AppendGrantInput {
  userId: string;
  amount: number;
  reason: string;
  idempotencyKey: string;
}

export interface AppendGrantResult {
  applied: boolean;
  balance: number;
}

export interface DebitInput {
  userId: string;
  credits: number;
  reason: string;
  idempotencyKey: string;
}

export interface DebitResult {
  applied: boolean;
  sufficient: boolean;
  balance: number;
}

export interface UsageEventInput {
  userId: string;
  kind: string;
  units: number;
  credits: number;
  model?: string;
  sessionId?: string;
}

export interface UsageEventDto {
  id: string;
  kind: string;
  units: number;
  credits: number;
  model?: string;
  sessionId?: string;
  createdAt: string;
}

export interface ListUsageEventsResult {
  events: UsageEventDto[];
  total: number;
  totalCreditsConsumed: number;
}

/** Persistence boundary for billing so the sqlite-backed implementation can be swapped for a fake in tests. */
export interface BillingStore {
  appendGrant(input: AppendGrantInput): Promise<AppendGrantResult>;
  debitIfSufficient(input: DebitInput): Promise<DebitResult>;
  getBalance(userId: string): Promise<number>;
  insertUsageEvent(input: UsageEventInput): Promise<void>;
  listUsageEvents(
    userId: string,
    options: { limit: number; offset: number },
  ): Promise<ListUsageEventsResult>;
}

export interface DevGrantPackage {
  id: string;
  label: string;
  credits: number;
}

export class InsufficientCreditsError extends Error {}
export class DevGrantsDisabledError extends Error {}
export class UnknownDevGrantPackageError extends Error {}
