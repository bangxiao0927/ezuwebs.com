import { parseAgentEvent, type AgentEvent } from "@ezu/protocol";
import type { EzuDb, OpenDatabaseOptions, AgentRunRow } from "@ezu/db";

import {
  RunAlreadyExistsError,
  RunNotFoundError,
  RunNotQueuedError,
  RunVersionConflictError,
  type CreateRunInput,
  type RunEventRecord,
  type RunRecord,
  type RunRepository,
} from "./run-repository.js";

function toRunRecord(row: AgentRunRow): RunRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    ...(row.userId ? { userId: row.userId } : {}),
    kind: row.kind,
    status: row.status,
    input: JSON.parse(row.inputJson),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
    cancelRequested: row.cancelRequested,
    version: row.version,
  };
}

export interface CreateSqliteRunRepositoryOptions extends OpenDatabaseOptions {
  /** Injects an already-open database, mainly so tests can close it deterministically. */
  db?: EzuDb;
}

/**
 * Backs runs by @ezu/db. The module is dynamically imported on first use so
 * importing this file never loads the better-sqlite3 native binding.
 */
export function createSqliteRunRepository(
  options: CreateSqliteRunRepositoryOptions = {},
): RunRepository {
  let dbPromise: Promise<EzuDb> | undefined;

  async function getDb(): Promise<EzuDb> {
    if (options.db) return options.db;
    if (!dbPromise) {
      dbPromise = import("@ezu/db").then(({ openDatabase }) => openDatabase({ runMigrations: true, ...options }));
    }
    return dbPromise;
  }

  return {
    async create(input: CreateRunInput) {
      const db = await getDb();
      const { createRunRow, RunAlreadyExistsError: DbRunAlreadyExistsError } = await import("@ezu/db");
      try {
        const row = createRunRow(db, {
          id: input.id,
          sessionId: input.sessionId,
          userId: input.userId ?? null,
          kind: input.kind,
          inputJson: JSON.stringify(input.input),
        });
        return toRunRecord(row);
      } catch (cause) {
        if (cause instanceof DbRunAlreadyExistsError) {
          throw new RunAlreadyExistsError(cause.message);
        }
        throw cause;
      }
    },

    async get(id) {
      const db = await getDb();
      const { getRunRow } = await import("@ezu/db");
      const row = getRunRow(db, id);
      return row ? toRunRecord(row) : undefined;
    },

    async claim(id) {
      const db = await getDb();
      const { getRunRow, updateRunRow, RunRowNotFoundError, RunVersionConflictError: DbRunVersionConflictError } =
        await import("@ezu/db");
      const existing = getRunRow(db, id);
      if (!existing) throw new RunNotFoundError(`Unknown run: ${id}`);
      if (existing.status !== "queued") {
        throw new RunNotQueuedError(`Run ${id} is not queued (status: ${existing.status})`);
      }
      try {
        const updated = updateRunRow(db, id, existing.version, { status: "running", startedAt: new Date() });
        return toRunRecord(updated);
      } catch (cause) {
        if (cause instanceof DbRunVersionConflictError) {
          throw new RunNotQueuedError(`Run ${id} is not queued: it was modified concurrently`);
        }
        if (cause instanceof RunRowNotFoundError) {
          throw new RunNotFoundError(cause.message);
        }
        throw cause;
      }
    },

    async appendEvent(runId, event) {
      const db = await getDb();
      const { appendRunEventRow, getRunRow } = await import("@ezu/db");
      if (!getRunRow(db, runId)) throw new RunNotFoundError(`Unknown run: ${runId}`);
      const row = appendRunEventRow(db, runId, JSON.stringify(event));
      return { seq: row.seq, event };
    },

    async requestCancel(id) {
      const db = await getDb();
      const { getRunRow, updateRunRow } = await import("@ezu/db");
      const existing = getRunRow(db, id);
      if (!existing) throw new RunNotFoundError(`Unknown run: ${id}`);
      if (
        existing.cancelRequested ||
        existing.status === "completed" ||
        existing.status === "failed" ||
        existing.status === "cancelled"
      ) {
        return toRunRecord(existing);
      }
      const updated = updateRunRow(db, id, existing.version, { cancelRequested: true });
      return toRunRecord(updated);
    },

    async complete(id, expectedVersion) {
      return transitionToTerminal(await getDb(), id, expectedVersion, "completed");
    },

    async fail(id, expectedVersion, error) {
      return transitionToTerminal(await getDb(), id, expectedVersion, "failed", error);
    },

    async cancel(id, expectedVersion) {
      return transitionToTerminal(await getDb(), id, expectedVersion, "cancelled");
    },

    async listEventsAfter(runId, afterSeq) {
      const db = await getDb();
      const { listRunEventRowsAfter } = await import("@ezu/db");
      return listRunEventRowsAfter(db, runId, afterSeq).map(
        (row): RunEventRecord => ({ seq: row.seq, event: parseAgentEvent(JSON.parse(row.eventJson)) }),
      );
    },

    async getLastEventSeq(runId) {
      const db = await getDb();
      const { getMaxRunEventSeq } = await import("@ezu/db");
      return getMaxRunEventSeq(db, runId);
    },

    async listRunningRuns() {
      const db = await getDb();
      const { listRunsByStatus } = await import("@ezu/db");
      return listRunsByStatus(db, "running").map(toRunRecord);
    },

    async listQueuedRuns() {
      const db = await getDb();
      const { listRunsByStatus } = await import("@ezu/db");
      return listRunsByStatus(db, "queued").map(toRunRecord);
    },

    async listRunsForSession(sessionId) {
      const db = await getDb();
      const { listRunsBySession } = await import("@ezu/db");
      return listRunsBySession(db, sessionId).map(toRunRecord);
    },
  };

  async function transitionToTerminal(
    db: EzuDb,
    id: string,
    expectedVersion: number,
    status: "completed" | "failed" | "cancelled",
    error?: string,
  ): Promise<RunRecord> {
    const { updateRunRow, RunRowNotFoundError, RunVersionConflictError: DbRunVersionConflictError } = await import(
      "@ezu/db"
    );
    try {
      const updated = updateRunRow(db, id, expectedVersion, {
        status,
        completedAt: new Date(),
        ...(error !== undefined ? { error } : {}),
      });
      return toRunRecord(updated);
    } catch (cause) {
      if (cause instanceof DbRunVersionConflictError) {
        throw new RunVersionConflictError(cause.message);
      }
      if (cause instanceof RunRowNotFoundError) {
        throw new RunNotFoundError(cause.message);
      }
      throw cause;
    }
  }
}
