import { desc, eq, sql } from "drizzle-orm";

import type { EzuDb } from "./client.js";
import { creditLedger, usageEvents, usageSettlements, type UsageEvent } from "./schema.js";

export type LedgerEntryType = "grant" | "debit" | "refund";

export interface AppendLedgerEntryInput {
  userId: string;
  type: LedgerEntryType;
  amount: number;
  reason: string;
  idempotencyKey: string;
}

export interface AppendLedgerEntryResult {
  applied: boolean;
  balance: number;
}

function ledgerBalance(db: EzuDb, userId: string): number {
  const row = db
    .select({ total: sql<number>`coalesce(sum(${creditLedger.amount}), 0)` })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId))
    .get();
  return row?.total ?? 0;
}

export function getLedgerBalance(db: EzuDb, userId: string): number {
  return ledgerBalance(db, userId);
}

/** Appends a grant or refund entry. Replaying the same idempotencyKey is a no-op. */
export function appendLedgerEntry(db: EzuDb, input: AppendLedgerEntryInput): AppendLedgerEntryResult {
  return db.transaction((tx) => {
    const existing = tx
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.idempotencyKey, input.idempotencyKey))
      .get();
    if (existing) {
      return { applied: false, balance: ledgerBalance(tx, input.userId) };
    }

    tx.insert(creditLedger)
      .values({
        id: crypto.randomUUID(),
        userId: input.userId,
        type: input.type,
        amount: input.amount,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        createdAt: new Date(),
      })
    .run();
    return { applied: true, balance: ledgerBalance(tx, input.userId) };
  });
}

export interface RefundLedgerEntryInput {
  userId: string;
  /** Positive amount to credit back. */
  amount: number;
  reason: string;
  /** The idempotencyKey of the debit being refunded; the refund's own key is derived from it. */
  debitIdempotencyKey: string;
}

/**
 * Refunds a prior debit. The refund's idempotencyKey is derived from
 * `debitIdempotencyKey`, so replaying a refund for the same debit is a no-op.
 */
export function refundLedgerEntry(db: EzuDb, input: RefundLedgerEntryInput): AppendLedgerEntryResult {
  return appendLedgerEntry(db, {
    userId: input.userId,
    type: "refund",
    amount: input.amount,
    reason: input.reason,
    idempotencyKey: `refund:${input.debitIdempotencyKey}`,
  });
}

export interface DebitIfSufficientInput {
  userId: string;
  credits: number;
  reason: string;
  idempotencyKey: string;
}

export interface DebitIfSufficientResult {
  applied: boolean;
  sufficient: boolean;
  balance: number;
}

/**
 * Debits `credits` from the user's ledger balance inside a transaction so the
 * balance check and the insert cannot race. Replaying the same
 * idempotencyKey is a no-op that reports the prior (successful) outcome.
 */
export function debitLedgerIfSufficient(
  db: EzuDb,
  input: DebitIfSufficientInput,
): DebitIfSufficientResult {
  return db.transaction((tx) => {
    const existing = tx
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.idempotencyKey, input.idempotencyKey))
      .get();
    if (existing) {
      return { applied: false, sufficient: true, balance: ledgerBalance(tx, input.userId) };
    }

    const balance = ledgerBalance(tx, input.userId);
    if (balance < input.credits) {
      return { applied: false, sufficient: false, balance };
    }

    tx.insert(creditLedger)
      .values({
        id: crypto.randomUUID(),
        userId: input.userId,
        type: "debit",
        amount: -input.credits,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        createdAt: new Date(),
      })
      .run();
    return { applied: true, sufficient: true, balance: balance - input.credits };
  });
}

export interface DebitAndRecordUsageInput {
  userId: string;
  credits: number;
  reason: string;
  idempotencyKey: string;
  usageEvent: InsertUsageEventInput;
}

export interface DebitAndRecordUsageResult {
  applied: boolean;
  sufficient: boolean;
  balance: number;
}

/**
 * Debits credits and records the matching usage event in a single
 * transaction, so a crash between the two can never leave a debited
 * balance with no usage record (or vice versa).
 */
export function debitAndRecordUsage(
  db: EzuDb,
  input: DebitAndRecordUsageInput,
): DebitAndRecordUsageResult {
  return db.transaction((tx) => {
    const existing = tx
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(eq(creditLedger.idempotencyKey, input.idempotencyKey))
      .get();
    if (existing) {
      return { applied: false, sufficient: true, balance: ledgerBalance(tx, input.userId) };
    }

    const balance = ledgerBalance(tx, input.userId);
    if (balance < input.credits) {
      return { applied: false, sufficient: false, balance };
    }

    tx.insert(creditLedger)
      .values({
        id: crypto.randomUUID(),
        userId: input.userId,
        type: "debit",
        amount: -input.credits,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        createdAt: new Date(),
      })
      .run();

    tx.insert(usageEvents)
      .values({
        id: input.usageEvent.id,
        userId: input.usageEvent.userId,
        kind: input.usageEvent.kind,
        units: input.usageEvent.units,
        credits: input.usageEvent.credits,
        model: input.usageEvent.model ?? null,
        sessionId: input.usageEvent.sessionId ?? null,
        status: input.usageEvent.status ?? "succeeded",
        metering: input.usageEvent.metering ?? "actual",
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .run();

    return { applied: true, sufficient: true, balance: balance - input.credits };
  });
}

export interface InsertUsageEventInput {
  id: string;
  userId: string;
  kind: string;
  units: number;
  credits: number;
  model?: string;
  sessionId?: string;
  status?: "succeeded" | "refunded";
  metering?: "actual" | "estimated";
}

/** Inserts a usage event. Replaying the same `id` is a no-op. */
export function insertUsageEvent(db: EzuDb, input: InsertUsageEventInput): void {
  db.insert(usageEvents)
    .values({
      id: input.id,
      userId: input.userId,
      kind: input.kind,
      units: input.units,
      credits: input.credits,
      model: input.model ?? null,
      sessionId: input.sessionId ?? null,
      status: input.status ?? "succeeded",
      metering: input.metering ?? "actual",
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .run();
}

/** Marks a usage event as refunded. Idempotent: replaying it is a no-op. */
export function markUsageEventRefunded(db: EzuDb, id: string): void {
  db.update(usageEvents).set({ status: "refunded" }).where(eq(usageEvents.id, id)).run();
}

export function getUsageEventStatus(db: EzuDb, id: string): "succeeded" | "refunded" | undefined {
  const row = db
    .select({ status: usageEvents.status })
    .from(usageEvents)
    .where(eq(usageEvents.id, id))
    .get();
  return row?.status;
}

export interface ListUsageEventsResult {
  events: UsageEvent[];
  total: number;
  totalCreditsConsumed: number;
}

export function listUsageEvents(
  db: EzuDb,
  userId: string,
  options: { limit: number; offset: number },
): ListUsageEventsResult {
  const events = db
    .select()
    .from(usageEvents)
    .where(eq(usageEvents.userId, userId))
    .orderBy(desc(usageEvents.createdAt), desc(usageEvents.id))
    .limit(options.limit)
    .offset(options.offset)
    .all();

  const aggregate = db
    .select({
      total: sql<number>`count(*)`,
      totalCreditsConsumed: sql<number>`coalesce(sum(case when ${usageEvents.status} = 'succeeded' then ${usageEvents.credits} else 0 end), 0)`,
    })
    .from(usageEvents)
    .where(eq(usageEvents.userId, userId))
    .get();

  return {
    events,
    total: aggregate?.total ?? 0,
    totalCreditsConsumed: aggregate?.totalCreditsConsumed ?? 0,
  };
}

export interface SettleUsageInput {
  userId: string;
  /** The run this settlement reconciles; also the settlement's idempotency key. */
  runId: string;
  /** The reservation's usage event id, updated in place with the settled totals. */
  usageEventId: string;
  reservedCredits: number;
  finalCredits: number;
  reason: string;
  metering: "actual" | "estimated";
  /** Overwrites the usage event's units (e.g. actual total tokens) when provided. */
  units?: number;
  /** Overwrites the usage event's model label when provided. */
  model?: string;
}

export interface SettleUsageResult {
  /** False when a settlement for this runId was already recorded (idempotent replay). */
  applied: boolean;
  /** False when finalCredits exceeded reservedCredits and the balance could not cover the top-up. */
  sufficient: boolean;
  balance: number;
  /** The credits actually settled to: reservedCredits when insufficient, finalCredits otherwise. */
  finalCredits: number;
}

/**
 * Reconciles a reservation against the final credits owed, in one
 * transaction: refunds the difference when the final charge is lower,
 * debits it when higher, and updates the reservation's usage event with the
 * settled totals. Never overdraws the balance: when the top-up would, the
 * reservation is kept as the final charge and `sufficient` is false.
 * Replaying the same runId is a no-op that reports the prior outcome.
 */
export function settleUsage(db: EzuDb, input: SettleUsageInput): SettleUsageResult {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(usageSettlements)
      .where(eq(usageSettlements.runId, input.runId))
      .get();
    if (existing) {
      return {
        applied: false,
        sufficient: existing.status === "settled",
        balance: ledgerBalance(tx, input.userId),
        finalCredits: existing.finalCredits,
      };
    }

    const difference = input.finalCredits - input.reservedCredits;
    let balance = ledgerBalance(tx, input.userId);

    if (difference > 0 && balance < difference) {
      tx.insert(usageSettlements)
        .values({
          runId: input.runId,
          userId: input.userId,
          usageEventId: input.usageEventId,
          reservedCredits: input.reservedCredits,
          finalCredits: input.reservedCredits,
          status: "insufficient",
          createdAt: new Date(),
        })
        .run();
      return { applied: true, sufficient: false, balance, finalCredits: input.reservedCredits };
    }

    if (difference > 0) {
      tx.insert(creditLedger)
        .values({
          id: crypto.randomUUID(),
          userId: input.userId,
          type: "debit",
          amount: -difference,
          reason: input.reason,
          idempotencyKey: `settle-debit:${input.runId}`,
          createdAt: new Date(),
        })
        .run();
      balance -= difference;
    } else if (difference < 0) {
      tx.insert(creditLedger)
        .values({
          id: crypto.randomUUID(),
          userId: input.userId,
          type: "refund",
          amount: -difference,
          reason: input.reason,
          idempotencyKey: `settle-refund:${input.runId}`,
          createdAt: new Date(),
        })
        .run();
      balance -= difference;
    }

    tx.update(usageEvents)
      .set({
        credits: input.finalCredits,
        metering: input.metering,
        ...(input.units !== undefined ? { units: input.units } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
      })
      .where(eq(usageEvents.id, input.usageEventId))
      .run();

    tx.insert(usageSettlements)
      .values({
        runId: input.runId,
        userId: input.userId,
        usageEventId: input.usageEventId,
        reservedCredits: input.reservedCredits,
        finalCredits: input.finalCredits,
        status: "settled",
        createdAt: new Date(),
      })
      .run();

    return { applied: true, sufficient: true, balance, finalCredits: input.finalCredits };
  });
}

export interface RunSettlementDto {
  /** Always true: getSettlement returns undefined when no settlement was ever recorded. */
  applied: true;
  /** False when the settlement recorded an insufficient top-up. */
  sufficient: boolean;
  finalCredits: number;
}

/** The persisted record of a run's settlement, or undefined if it was never settled. */
export function getSettlement(db: EzuDb, runId: string): RunSettlementDto | undefined {
  const row = db.select().from(usageSettlements).where(eq(usageSettlements.runId, runId)).get();
  if (!row) return undefined;
  return { applied: true, sufficient: row.status === "settled", finalCredits: row.finalCredits };
}
