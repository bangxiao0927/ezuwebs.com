import { recoverInterruptedActions } from "@ezu/core";
import { parseAgentEvent, type AgentEvent } from "@ezu/protocol";
import type { EzuDb, OpenDatabaseOptions } from "@ezu/db";

import {
  deriveLatestActions,
  type SessionRecord,
  type SessionRepository,
} from "./session-repository.js";
import { type InteractiveWebEditorState, type WebAppBootstrap } from "./view-model.js";
import {
  diffWorkspaceFilesFromBaseline,
  getDefaultWorkspaceSnapshot,
  getWorkspaceBaselineVersion,
  parseWorkspaceBaselineFilesJson,
  reconstructWorkspaceFilesFromBaseline,
  serializeWorkspaceBaselineFiles,
  WorkspaceBaselineMissingError,
  type WorkspaceFileEntry,
} from "./workspace.js";

export class SessionRowMissingError extends Error {}
export class SessionSaveConflictError extends Error {}

type BootstrapRest = Omit<WebAppBootstrap, "sessionId" | "projectId" | "initialEvents" | "workspaceFiles">;

function bootstrapRestOf(bootstrap: WebAppBootstrap): BootstrapRest {
  const { sessionId: _sessionId, projectId: _projectId, initialEvents: _initialEvents, workspaceFiles: _workspaceFiles, ...rest } =
    bootstrap;
  return rest;
}

function parseBootstrapRest(value: unknown): BootstrapRest {
  if (!value || typeof value !== "object") {
    throw new Error("Stored session bootstrap JSON is not an object");
  }
  const candidate = value as Record<string, unknown>;
  const config = candidate["config"];
  if (!config || typeof config !== "object") {
    throw new Error("Stored session bootstrap.config JSON is not an object");
  }
  const configCandidate = config as Record<string, unknown>;
  if (typeof configCandidate["projectName"] !== "string") {
    throw new Error("Stored session bootstrap.config.projectName is not a string");
  }
  if (configCandidate["runtimeType"] !== "browser" && configCandidate["runtimeType"] !== "remote") {
    throw new Error("Stored session bootstrap.config.runtimeType is not browser or remote");
  }
  return candidate as unknown as BootstrapRest;
}

function parseInteractiveWebEditorState(value: unknown): InteractiveWebEditorState {
  if (!value || typeof value !== "object") {
    throw new Error("Stored session webEditor JSON is not an object");
  }
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate["blocks"])) {
    throw new Error("Stored session webEditor.blocks JSON is not an array");
  }
  if (!Array.isArray(candidate["properties"])) {
    throw new Error("Stored session webEditor.properties JSON is not an array");
  }
  return candidate as unknown as InteractiveWebEditorState;
}

const versionSymbol = Symbol("sqlite-session-repository-version");

function attachVersion<T extends object>(record: T, version: number): T {
  Object.defineProperty(record, versionSymbol, { value: version, enumerable: false, configurable: true });
  return record;
}

function readVersion(record: SessionRecord): number {
  const version = (record as unknown as Record<symbol, unknown>)[versionSymbol];
  if (typeof version !== "number") {
    throw new Error(
      "SessionRecord was not loaded through createSqliteSessionRepository; cannot determine its version for an optimistic-concurrency save",
    );
  }
  return version;
}

function eventsToRows(events: AgentEvent[], startingSeq: number): { seq: number; eventJson: string }[] {
  return events.slice(startingSeq).map((event, index) => ({
    seq: startingSeq + index,
    eventJson: JSON.stringify(event),
  }));
}

export interface CreateSqliteSessionRepositoryOptions extends OpenDatabaseOptions {
  /** Injects an already-open database, mainly so tests can close it deterministically. */
  db?: EzuDb;
}

/**
 * Backs sessions by @ezu/db. The module is dynamically imported on first use
 * so importing this file never loads the better-sqlite3 native binding.
 */
export function createSqliteSessionRepository(
  options: CreateSqliteSessionRepositoryOptions = {},
): SessionRepository {
  let dbPromise: Promise<EzuDb> | undefined;

  async function getDb(): Promise<EzuDb> {
    if (options.db) {
      return options.db;
    }
    if (!dbPromise) {
      dbPromise = import("@ezu/db").then(({ openDatabase }) => openDatabase({ runMigrations: true, ...options }));
    }
    return dbPromise;
  }

  async function loadBaselineFiles(db: EzuDb, version: string): Promise<WorkspaceFileEntry[]> {
    const { getWorkspaceBaselineRow } = await import("@ezu/db");
    const baseline = getWorkspaceBaselineRow(db, version);
    if (!baseline) {
      throw new WorkspaceBaselineMissingError(
        `Workspace baseline ${version} referenced by a session is missing; cannot reconstruct its workspace files`,
      );
    }
    return parseWorkspaceBaselineFilesJson(version, baseline.filesJson);
  }

  async function fromRow(db: EzuDb, bundle: import("@ezu/db").SessionRowBundle): Promise<SessionRecord> {
    const bootstrapRest = parseBootstrapRest(JSON.parse(bundle.session.bootstrapJson));
    const webEditor = parseInteractiveWebEditorState(JSON.parse(bundle.session.webEditorJson));
    const events = bundle.events.map((row) => parseAgentEvent(JSON.parse(row.eventJson)));
    const workspaceFiles = bundle.session.workspaceBaselineVersion
      ? reconstructWorkspaceFilesFromBaseline(
          bundle.workspaceFiles.map((row) => ({ path: row.path, content: row.content })),
          await loadBaselineFiles(db, bundle.session.workspaceBaselineVersion),
        )
      : undefined;

    const bootstrap: WebAppBootstrap = {
      ...bootstrapRest,
      sessionId: bundle.session.id,
      projectId: bundle.session.projectId,
      initialEvents: events,
      ...(workspaceFiles ? { workspaceFiles } : {}),
    };

    const record: SessionRecord = {
      id: bundle.session.id,
      definitionId: bundle.session.definitionId,
      bootstrap,
      events,
      webEditor,
      ...(bundle.session.ownerUserId ? { ownerUserId: bundle.session.ownerUserId } : {}),
    };

    return attachVersion(record, bundle.session.version);
  }

  function currentWorkspaceBaselineForPersistence(): { version: string; filesJson: string } {
    return {
      version: getWorkspaceBaselineVersion(),
      filesJson: serializeWorkspaceBaselineFiles(getDefaultWorkspaceSnapshot().files),
    };
  }

  return {
    async create(record) {
      const db = await getDb();
      const { createSessionRow } = await import("@ezu/db");
      const workspaceFiles = record.bootstrap.workspaceFiles;
      const workspaceBaseline = workspaceFiles ? currentWorkspaceBaselineForPersistence() : undefined;

      createSessionRow(db, {
        id: record.id,
        ownerUserId: record.ownerUserId ?? null,
        definitionId: record.definitionId,
        projectId: record.bootstrap.projectId,
        bootstrapJson: JSON.stringify(bootstrapRestOf(record.bootstrap)),
        webEditorJson: JSON.stringify(record.webEditor),
        workspaceBaselineVersion: workspaceBaseline?.version ?? null,
        workspaceBaseline: workspaceBaseline ?? null,
        events: eventsToRows(record.events, 0),
        workspaceFiles: workspaceFiles ? diffWorkspaceFilesFromBaseline(workspaceFiles) : [],
      });

      attachVersion(record, 1);
    },

    async get(id) {
      const db = await getDb();
      const { getSessionRowBundle } = await import("@ezu/db");
      const bundle = getSessionRowBundle(db, id);
      return bundle ? fromRow(db, bundle) : undefined;
    },

    async save(record) {
      const db = await getDb();
      const { getSessionRowBundle, updateSessionRow, SessionRowNotFoundError, SessionVersionConflictError } =
        await import("@ezu/db");

      const expectedVersion = readVersion(record);
      const current = getSessionRowBundle(db, record.id);
      if (!current) {
        throw new SessionRowMissingError(`Unknown session: ${record.id}`);
      }
      if (record.events.length < current.events.length) {
        throw new Error(
          `Session ${record.id} events array is shorter than the persisted history; events must only be appended`,
        );
      }

      const workspaceFiles = record.bootstrap.workspaceFiles;
      const workspaceBaseline = workspaceFiles ? currentWorkspaceBaselineForPersistence() : undefined;
      const desiredOverrides = workspaceFiles ? diffWorkspaceFilesFromBaseline(workspaceFiles) : [];
      const desiredByPath = new Map(desiredOverrides.map((override) => [override.path, override.content]));
      const currentByPath = new Map(current.workspaceFiles.map((row) => [row.path, row.content]));

      const workspaceUpserts = desiredOverrides.filter(
        (override) => currentByPath.get(override.path) !== override.content || !currentByPath.has(override.path),
      );
      const workspaceDeletePaths = [...currentByPath.keys()].filter((path) => !desiredByPath.has(path));

      try {
        const updated = updateSessionRow(db, {
          id: record.id,
          expectedVersion,
          bootstrapJson: JSON.stringify(bootstrapRestOf(record.bootstrap)),
          webEditorJson: JSON.stringify(record.webEditor),
          workspaceBaselineVersion: workspaceBaseline?.version ?? null,
          workspaceBaseline: workspaceBaseline ?? null,
          newEvents: eventsToRows(record.events, current.events.length),
          workspaceUpserts,
          workspaceDeletePaths,
        });
        attachVersion(record, updated.version);
      } catch (cause) {
        if (cause instanceof SessionRowNotFoundError) {
          throw new SessionRowMissingError(cause.message);
        }
        if (cause instanceof SessionVersionConflictError) {
          throw new SessionSaveConflictError(cause.message);
        }
        throw cause;
      }
    },

    async list() {
      const db = await getDb();
      const { listSessionIds, getSessionRowBundle } = await import("@ezu/db");
      const records: SessionRecord[] = [];
      for (const id of listSessionIds(db)) {
        const bundle = getSessionRowBundle(db, id);
        if (bundle) {
          records.push(await fromRow(db, bundle));
        }
      }
      return records;
    },

    async listSummariesForOwner(ownerUserId) {
      const db = await getDb();
      const { listSessionSummariesForOwner } = await import("@ezu/db");
      return listSessionSummariesForOwner(db, ownerUserId);
    },

    async recoverInterruptedSessions() {
      const records = await this.list();
      for (const record of records) {
        const recoveryEvents = recoverInterruptedActions(deriveLatestActions(record));
        if (recoveryEvents.length > 0) {
          record.events = [...record.events, ...recoveryEvents];
          await this.save(record);
        }
      }
    },
  };
}
