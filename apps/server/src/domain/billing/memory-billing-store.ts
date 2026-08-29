import type {
  AppendGrantInput,
  AppendGrantResult,
  BillingStore,
  DebitAndRecordUsageInput,
  DebitAndRecordUsageResult,
  DebitInput,
  DebitResult,
  ListUsageEventsResult,
  RefundDebitInput,
  RefundDebitResult,
  UsageEventInput,
} from "./store.js";

interface LedgerRow {
  userId: string;
  amount: number;
  idempotencyKey: string;
}

interface UsageRow {
  id: string;
  userId: string;
  kind: string;
  units: number;
  credits: number;
  model?: string;
  sessionId?: string;
  status: "succeeded" | "refunded";
  createdAt: string;
}

export function createMemoryBillingStore(): BillingStore {
  const ledger: LedgerRow[] = [];
  const usage: UsageRow[] = [];
  const idempotencyKeys = new Set<string>();

  function balanceFor(userId: string): number {
    return ledger
      .filter((row) => row.userId === userId)
      .reduce((sum, row) => sum + row.amount, 0);
  }

  function insertUsageRow(input: UsageEventInput): void {
    if (usage.some((row) => row.id === input.id)) {
      return;
    }
    usage.push({
      id: input.id,
      userId: input.userId,
      kind: input.kind,
      units: input.units,
      credits: input.credits,
      ...(input.model ? { model: input.model } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      status: input.status ?? "succeeded",
      createdAt: new Date().toISOString(),
    });
  }

  return {
    async appendGrant(input: AppendGrantInput): Promise<AppendGrantResult> {
      if (idempotencyKeys.has(input.idempotencyKey)) {
        return { applied: false, balance: balanceFor(input.userId) };
      }
      idempotencyKeys.add(input.idempotencyKey);
      ledger.push({ userId: input.userId, amount: input.amount, idempotencyKey: input.idempotencyKey });
      return { applied: true, balance: balanceFor(input.userId) };
    },

    async debitIfSufficient(input: DebitInput): Promise<DebitResult> {
      if (idempotencyKeys.has(input.idempotencyKey)) {
        return { applied: false, sufficient: true, balance: balanceFor(input.userId) };
      }
      const balance = balanceFor(input.userId);
      if (balance < input.credits) {
        return { applied: false, sufficient: false, balance };
      }
      idempotencyKeys.add(input.idempotencyKey);
      ledger.push({ userId: input.userId, amount: -input.credits, idempotencyKey: input.idempotencyKey });
      return { applied: true, sufficient: true, balance: balance - input.credits };
    },

    async debitAndRecordUsage(input: DebitAndRecordUsageInput): Promise<DebitAndRecordUsageResult> {
      if (idempotencyKeys.has(input.debitIdempotencyKey)) {
        return { applied: false, sufficient: true, balance: balanceFor(input.userId) };
      }
      const balance = balanceFor(input.userId);
      if (balance < input.credits) {
        return { applied: false, sufficient: false, balance };
      }
      idempotencyKeys.add(input.debitIdempotencyKey);
      ledger.push({ userId: input.userId, amount: -input.credits, idempotencyKey: input.debitIdempotencyKey });
      insertUsageRow(input.usageEvent);
      return { applied: true, sufficient: true, balance: balance - input.credits };
    },

    async refundDebit(input: RefundDebitInput): Promise<RefundDebitResult> {
      const idempotencyKey = `refund:${input.debitIdempotencyKey}`;
      if (idempotencyKeys.has(idempotencyKey)) {
        return { applied: false, balance: balanceFor(input.userId) };
      }
      idempotencyKeys.add(idempotencyKey);
      ledger.push({ userId: input.userId, amount: input.credits, idempotencyKey });
      return { applied: true, balance: balanceFor(input.userId) };
    },

    async getBalance(userId: string): Promise<number> {
      return balanceFor(userId);
    },

    async insertUsageEvent(input: UsageEventInput): Promise<void> {
      insertUsageRow(input);
    },

    async markUsageEventRefunded(usageEventId: string): Promise<void> {
      const row = usage.find((candidate) => candidate.id === usageEventId);
      if (row) {
        row.status = "refunded";
      }
    },

    async listUsageEvents(
      userId: string,
      options: { limit: number; offset: number },
    ): Promise<ListUsageEventsResult> {
      const owned = usage
        .filter((row) => row.userId === userId)
        .slice()
        .sort((a, b) => {
          if (a.createdAt !== b.createdAt) {
            return a.createdAt < b.createdAt ? 1 : -1;
          }
          return a.id < b.id ? 1 : -1;
        });
      const total = owned.length;
      const totalCreditsConsumed = owned
        .filter((row) => row.status === "succeeded")
        .reduce((sum, row) => sum + row.credits, 0);
      const page = owned.slice(options.offset, options.offset + options.limit).map((row) => {
        const { userId: _userId, ...dto } = row;
        return dto;
      });
      return { events: page, total, totalCreditsConsumed };
    },

    async getUsageEventStatus(usageEventId: string): Promise<"succeeded" | "refunded" | undefined> {
      return usage.find((row) => row.id === usageEventId)?.status;
    },
  };
}
