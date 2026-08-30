import { and, asc, eq, gt, max } from "drizzle-orm";

import type { EzuDb } from "./client.js";
import { agentRuns, runEvents, type AgentRunRow, type RunEventRow } from "./schema.js";

export class RunAlreadyExistsError extends Error {}
export class RunRowNotFoundError extends Error {}
export class RunVersionConflictError extends Error {}

export type RunStatus = AgentRunRow["status"];

export interface CreateRunRowInput {
  id: string;
  sessionId: string;
  userId?: string | null;
  kind: string;
  inputJson: string;
}

function isUniqueConstraintError(cause: unknown, constraint: string): boolean {
  return cause instanceof Error && cause.message.includes(constraint);
}

export function createRunRow(db: EzuDb, input: CreateRunRowInput): AgentRunRow {
  const now = new Date();
  try {
    const created = db
      .insert(agentRuns)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        userId: input.userId ?? null,
        kind: input.kind,
        status: "queued",
        inputJson: input.inputJson,
        createdAt: now,
        cancelRequested: false,
        version: 1,
      })
      .returning()
      .get();
    return created;
  } catch (cause) {
    if (isUniqueConstraintError(cause, "agent_runs.id")) {
      throw new RunAlreadyExistsError(`Run already exists: ${input.id}`);
    }
    throw cause;
  }
}

export function getRunRow(db: EzuDb, id: string): AgentRunRow | undefined {
  return db.select().from(agentRuns).where(eq(agentRuns.id, id)).get();
}

export function listRunsByStatus(db: EzuDb, status: RunStatus): AgentRunRow[] {
  return db.select().from(agentRuns).where(eq(agentRuns.status, status)).all();
}

export interface UpdateRunRowPatch {
  status?: RunStatus;
  error?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  cancelRequested?: boolean;
}

/**
 * Applies a patch to a run row, gated by an optimistic-concurrency check on
 * `version`. Throws RunVersionConflictError if the row moved since the
 * caller last read it, so two writers can never silently clobber a status
 * transition.
 */
export function updateRunRow(
  db: EzuDb,
  id: string,
  expectedVersion: number,
  patch: UpdateRunRowPatch,
): AgentRunRow {
  const updated = db
    .update(agentRuns)
    .set({ ...patch, version: expectedVersion + 1 })
    .where(and(eq(agentRuns.id, id), eq(agentRuns.version, expectedVersion)))
    .returning()
    .get();
  if (updated) return updated;

  const existing = getRunRow(db, id);
  if (!existing) throw new RunRowNotFoundError(`Unknown run: ${id}`);
  throw new RunVersionConflictError(`Run ${id} was modified concurrently`);
}

/**
 * Appends an event with the next sequence number for this run, inside a
 * transaction so the seq allocation and insert are atomic against
 * concurrent appends to the same run.
 */
export function appendRunEventRow(db: EzuDb, runId: string, eventJson: string): RunEventRow {
  return db.transaction((tx) => {
    const row = tx
      .select({ maxSeq: max(runEvents.seq) })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .get();
    const nextSeq = (row?.maxSeq ?? 0) + 1;
    return tx
      .insert(runEvents)
      .values({
        id: crypto.randomUUID(),
        runId,
        seq: nextSeq,
        eventJson,
        createdAt: new Date(),
      })
      .returning()
      .get();
  });
}

export function listRunEventRowsAfter(db: EzuDb, runId: string, afterSeq: number): RunEventRow[] {
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
    .orderBy(asc(runEvents.seq))
    .all();
}

/**
 * Highest seq recorded for a run, without reading any event rows. Used by
 * SSE polling to detect "caught up to a terminal run" cheaply.
 */
export function getMaxRunEventSeq(db: EzuDb, runId: string): number {
  const row = db
    .select({ maxSeq: max(runEvents.seq) })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .get();
  return row?.maxSeq ?? 0;
}
