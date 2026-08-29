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

export interface RefundDebitInput {
  userId: string;
  /** Positive amount to credit back. */
  credits: number;
  reason: string;
  /** The idempotencyKey of the debit being refunded; the refund's own idempotency is derived from it. */
  debitIdempotencyKey: string;
}

export interface RefundDebitResult {
  applied: boolean;
  balance: number;
}

export interface UsageEventInput {
  id: string;
  userId: string;
  kind: string;
  units: number;
  credits: number;
  model?: string;
  sessionId?: string;
  status?: "succeeded" | "refunded";
}

export interface UsageEventDto {
  id: string;
  kind: string;
  units: number;
  credits: number;
  model?: string;
  sessionId?: string;
  status: "succeeded" | "refunded";
  createdAt: string;
}

export interface ListUsageEventsResult {
  events: UsageEventDto[];
  total: number;
  totalCreditsConsumed: number;
}

export interface DebitAndRecordUsageInput {
  userId: string;
  credits: number;
  debitReason: string;
  debitIdempotencyKey: string;
  usageEvent: UsageEventInput;
}

export interface DebitAndRecordUsageResult {
  applied: boolean;
  sufficient: boolean;
  balance: number;
}

/** Persistence boundary for billing so the sqlite-backed implementation can be swapped for a fake in tests. */
export interface BillingStore {
  appendGrant(input: AppendGrantInput): Promise<AppendGrantResult>;
  debitIfSufficient(input: DebitInput): Promise<DebitResult>;
  /** Debits credits and records the matching usage event as a single atomic operation. */
  debitAndRecordUsage(input: DebitAndRecordUsageInput): Promise<DebitAndRecordUsageResult>;
  refundDebit(input: RefundDebitInput): Promise<RefundDebitResult>;
  getBalance(userId: string): Promise<number>;
  insertUsageEvent(input: UsageEventInput): Promise<void>;
  markUsageEventRefunded(usageEventId: string): Promise<void>;
  listUsageEvents(
    userId: string,
    options: { limit: number; offset: number },
  ): Promise<ListUsageEventsResult>;
  getUsageEventStatus(usageEventId: string): Promise<"succeeded" | "refunded" | undefined>;
}

export interface DevGrantPackage {
  id: string;
  label: string;
  credits: number;
}

export class InsufficientCreditsError extends Error {}
export class DevGrantsDisabledError extends Error {}
export class UnknownDevGrantPackageError extends Error {}
export class MissingIdempotencyKeyError extends Error {}
/** A prior attempt for this requestId ran and was refunded; retrying with the same requestId is refused. */
export class PreviousAttemptFailedError extends Error {}
/** A refund was requested for a requestId that was never successfully charged. */
export class RefundConflictError extends Error {}
