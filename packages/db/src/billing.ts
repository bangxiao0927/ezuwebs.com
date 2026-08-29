import { desc, eq, sql } from "drizzle-orm";

import type { EzuDb } from "./client.js";
import { creditLedger, usageEvents, type UsageEvent } from "./schema.js";

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

export interface InsertUsageEventInput {
  userId: string;
  kind: string;
  units: number;
  credits: number;
  model?: string;
  sessionId?: string;
}

export function insertUsageEvent(db: EzuDb, input: InsertUsageEventInput): void {
  db.insert(usageEvents)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      kind: input.kind,
      units: input.units,
      credits: input.credits,
      model: input.model ?? null,
      sessionId: input.sessionId ?? null,
      createdAt: new Date(),
    })
    .run();
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
    .orderBy(desc(usageEvents.createdAt))
    .limit(options.limit)
    .offset(options.offset)
    .all();

  const aggregate = db
    .select({
      total: sql<number>`count(*)`,
      totalCreditsConsumed: sql<number>`coalesce(sum(${usageEvents.credits}), 0)`,
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
