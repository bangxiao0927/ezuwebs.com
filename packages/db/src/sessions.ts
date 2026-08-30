import { and, asc, eq, inArray } from "drizzle-orm";

import type { EzuDb } from "./client.js";
import {
  sessionEvents,
  sessions,
  workspaceFiles,
  workspaceBaselines,
  type SessionEventRow,
  type SessionRow,
  type WorkspaceFileRow,
  type WorkspaceBaselineRow,
} from "./schema.js";

export class SessionAlreadyExistsError extends Error {}
export class SessionRowNotFoundError extends Error {}
export class SessionVersionConflictError extends Error {}

export interface SessionEventInsert {
  seq: number;
  eventJson: string;
}

export interface WorkspaceFileInsert {
  path: string;
  /** Null marks a tombstone: a baseline file this session has removed. */
  content: string | null;
}

export interface CreateSessionRowInput {
  id: string;
  ownerUserId?: string | null;
  definitionId: string;
  projectId: string;
  bootstrapJson: string;
  webEditorJson: string;
  workspaceBaselineVersion?: string | null;
  /** Full baseline snapshot to persist (insert-or-ignore) alongside the session. */
  workspaceBaseline?: { version: string; filesJson: string } | null;
  events: SessionEventInsert[];
  workspaceFiles: WorkspaceFileInsert[];
}

function isUniqueConstraintError(cause: unknown, constraint: string): boolean {
  return cause instanceof Error && cause.message.includes(constraint);
}

/** Inserts a session with its initial events and workspace file overrides in a single transaction. */
export function createSessionRow(db: EzuDb, input: CreateSessionRowInput): SessionRow {
  return db.transaction((tx) => {
    const now = new Date();
    let created: SessionRow | undefined;

    if (input.workspaceBaseline) {
      tx.insert(workspaceBaselines)
        .values({
          version: input.workspaceBaseline.version,
          filesJson: input.workspaceBaseline.filesJson,
          createdAt: now,
        })
        .onConflictDoNothing()
        .run();
    }

    try {
      created = tx
        .insert(sessions)
        .values({
          id: input.id,
          ownerUserId: input.ownerUserId ?? null,
          definitionId: input.definitionId,
          projectId: input.projectId,
          bootstrapJson: input.bootstrapJson,
          webEditorJson: input.webEditorJson,
          workspaceBaselineVersion: input.workspaceBaselineVersion ?? null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    } catch (cause) {
      if (isUniqueConstraintError(cause, "sessions.id")) {
        throw new SessionAlreadyExistsError(`Session already exists: ${input.id}`);
      }
      throw cause;
    }
    if (!created) throw new Error("Failed to insert session");

    for (const event of input.events) {
      tx.insert(sessionEvents)
        .values({
          id: crypto.randomUUID(),
          sessionId: input.id,
          seq: event.seq,
          eventJson: event.eventJson,
          createdAt: now,
        })
        .run();
    }

    for (const file of input.workspaceFiles) {
      tx.insert(workspaceFiles)
        .values({
          id: crypto.randomUUID(),
          sessionId: input.id,
          path: file.path,
          content: file.content,
          updatedAt: now,
        })
        .run();
    }

    return created;
  });
}

export interface SessionRowBundle {
  session: SessionRow;
  events: SessionEventRow[];
  workspaceFiles: WorkspaceFileRow[];
}

/** Reads a session with its full event history (ordered) and workspace file overrides. */
export function getSessionRowBundle(db: EzuDb, id: string): SessionRowBundle | undefined {
  const session = db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (!session) return undefined;

  const events = db
    .select()
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, id))
    .orderBy(asc(sessionEvents.seq))
    .all();
  const files = db.select().from(workspaceFiles).where(eq(workspaceFiles.sessionId, id)).all();

  return { session, events, workspaceFiles: files };
}

export function listSessionIds(db: EzuDb): string[] {
  return db
    .select({ id: sessions.id })
    .from(sessions)
    .all()
    .map((row) => row.id);
}

export interface SessionSummaryRow {
  id: string;
  definitionId: string;
}

/**
 * Owner-scoped listing that reads only id/definitionId columns via the
 * sessions_owner_user_id_idx index, without touching events or workspace
 * file rows. Backs lightweight dashboard listings.
 */
export function listSessionSummariesForOwner(db: EzuDb, ownerUserId: string): SessionSummaryRow[] {
  return db
    .select({ id: sessions.id, definitionId: sessions.definitionId })
    .from(sessions)
    .where(eq(sessions.ownerUserId, ownerUserId))
    .all();
}

export function sessionRowExists(db: EzuDb, id: string): boolean {
  return db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id)).get() !== undefined;
}

export interface UpdateSessionRowInput {
  id: string;
  expectedVersion: number;
  bootstrapJson: string;
  webEditorJson: string;
  workspaceBaselineVersion?: string | null;
  /** Full baseline snapshot to persist (insert-or-ignore) alongside the update. */
  workspaceBaseline?: { version: string; filesJson: string } | null;
  /** Events beyond what is already persisted, in seq order. Never rewrites prior rows. */
  newEvents: SessionEventInsert[];
  workspaceUpserts: WorkspaceFileInsert[];
  workspaceDeletePaths: string[];
}

/**
 * Updates a session's bootstrap/editor state, appends new events, and
 * reconciles workspace file overrides, all inside one transaction.
 * Uses compare-and-swap on `version` to reject lost updates from another
 * instance that saved the same session since it was last read.
 */
export function updateSessionRow(db: EzuDb, input: UpdateSessionRowInput): SessionRow {
  return db.transaction((tx) => {
    const current = tx.select().from(sessions).where(eq(sessions.id, input.id)).get();
    if (!current) {
      throw new SessionRowNotFoundError(`Unknown session: ${input.id}`);
    }
    if (current.version !== input.expectedVersion) {
      throw new SessionVersionConflictError(
        `Session ${input.id} was modified concurrently (expected version ${input.expectedVersion}, found ${current.version})`,
      );
    }

    const now = new Date();

    if (input.workspaceBaseline) {
      tx.insert(workspaceBaselines)
        .values({
          version: input.workspaceBaseline.version,
          filesJson: input.workspaceBaseline.filesJson,
          createdAt: now,
        })
        .onConflictDoNothing()
        .run();
    }

    const updated = tx
      .update(sessions)
      .set({
        bootstrapJson: input.bootstrapJson,
        webEditorJson: input.webEditorJson,
        workspaceBaselineVersion: input.workspaceBaselineVersion ?? null,
        version: current.version + 1,
        updatedAt: now,
      })
      .where(and(eq(sessions.id, input.id), eq(sessions.version, input.expectedVersion)))
      .returning()
      .get();
    if (!updated) {
      throw new SessionVersionConflictError(
        `Session ${input.id} was modified concurrently (expected version ${input.expectedVersion})`,
      );
    }

    for (const event of input.newEvents) {
      tx.insert(sessionEvents)
        .values({
          id: crypto.randomUUID(),
          sessionId: input.id,
          seq: event.seq,
          eventJson: event.eventJson,
          createdAt: now,
        })
        .run();
    }

    for (const file of input.workspaceUpserts) {
      tx.insert(workspaceFiles)
        .values({
          id: crypto.randomUUID(),
          sessionId: input.id,
          path: file.path,
          content: file.content,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [workspaceFiles.sessionId, workspaceFiles.path],
          set: { content: file.content, updatedAt: now },
        })
        .run();
    }

    if (input.workspaceDeletePaths.length > 0) {
      tx.delete(workspaceFiles)
        .where(
          and(eq(workspaceFiles.sessionId, input.id), inArray(workspaceFiles.path, input.workspaceDeletePaths)),
        )
        .run();
    }

    return updated;
  });
}

/** Reads a persisted workspace baseline snapshot by version, if one has been stored. */
export function getWorkspaceBaselineRow(db: EzuDb, version: string): WorkspaceBaselineRow | undefined {
  return db.select().from(workspaceBaselines).where(eq(workspaceBaselines.version, version)).get();
}
