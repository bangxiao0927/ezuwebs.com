import type { EzuDb, OpenDatabaseOptions, UsageEvent } from "@ezu/db";

import type {
  AppendGrantInput,
  AppendGrantResult,
  BillingStore,
  DebitInput,
  DebitResult,
  ListUsageEventsResult,
  RefundDebitInput,
  RefundDebitResult,
  UsageEventDto,
  UsageEventInput,
} from "./store.js";

function toUsageEventDto(event: UsageEvent): UsageEventDto {
  return {
    id: event.id,
    kind: event.kind,
    units: event.units,
    credits: event.credits,
    ...(event.model ? { model: event.model } : {}),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    status: event.status,
    createdAt: event.createdAt.toISOString(),
  };
}

/**
 * Backs billing by @ezu/db. The module is dynamically imported on first use
 * so importing this file never loads the better-sqlite3 native binding.
 */
export function createSqliteBillingStore(options: OpenDatabaseOptions = {}): BillingStore {
  let dbPromise: Promise<EzuDb> | undefined;

  async function getDb(): Promise<EzuDb> {
    if (!dbPromise) {
      dbPromise = import("@ezu/db").then(({ openDatabase }) =>
        openDatabase({ runMigrations: true, ...options }),
      );
    }
    return dbPromise;
  }

  return {
    async appendGrant(input: AppendGrantInput): Promise<AppendGrantResult> {
      const [db, { appendLedgerEntry }] = await Promise.all([getDb(), import("@ezu/db")]);
      return appendLedgerEntry(db, {
        userId: input.userId,
        type: "grant",
        amount: input.amount,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
    },

    async debitIfSufficient(input: DebitInput): Promise<DebitResult> {
      const [db, { debitLedgerIfSufficient }] = await Promise.all([getDb(), import("@ezu/db")]);
      return debitLedgerIfSufficient(db, input);
    },

    async refundDebit(input: RefundDebitInput): Promise<RefundDebitResult> {
      const [db, { refundLedgerEntry }] = await Promise.all([getDb(), import("@ezu/db")]);
      return refundLedgerEntry(db, {
        userId: input.userId,
        amount: input.credits,
        reason: input.reason,
        debitIdempotencyKey: input.debitIdempotencyKey,
      });
    },

    async getBalance(userId: string): Promise<number> {
      const [db, { getLedgerBalance }] = await Promise.all([getDb(), import("@ezu/db")]);
      return getLedgerBalance(db, userId);
    },

    async insertUsageEvent(input: UsageEventInput): Promise<void> {
      const [db, { insertUsageEvent }] = await Promise.all([getDb(), import("@ezu/db")]);
      insertUsageEvent(db, input);
    },

    async markUsageEventRefunded(usageEventId: string): Promise<void> {
      const [db, { markUsageEventRefunded }] = await Promise.all([getDb(), import("@ezu/db")]);
      markUsageEventRefunded(db, usageEventId);
    },

    async getUsageEventStatus(usageEventId: string): Promise<"succeeded" | "refunded" | undefined> {
      const [db, { getUsageEventStatus }] = await Promise.all([getDb(), import("@ezu/db")]);
      return getUsageEventStatus(db, usageEventId);
    },

    async listUsageEvents(
      userId: string,
      options: { limit: number; offset: number },
    ): Promise<ListUsageEventsResult> {
      const [db, { listUsageEvents }] = await Promise.all([getDb(), import("@ezu/db")]);
      const result = listUsageEvents(db, userId, options);
      return {
        events: result.events.map(toUsageEventDto),
        total: result.total,
        totalCreditsConsumed: result.totalCreditsConsumed,
      };
    },
  };
}
