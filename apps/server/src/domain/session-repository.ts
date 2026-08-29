import { applyAgentEvent, createSessionState, recoverInterruptedActions } from "@ezu/core";
import { type AgentEvent } from "@ezu/protocol";

import { type InteractiveWebEditorState, type WebAppBootstrap } from "./view-model.js";

export interface SessionRecord {
  id: string;
  definitionId: string;
  bootstrap: WebAppBootstrap;
  events: AgentEvent[];
  webEditor: InteractiveWebEditorState;
  ownerUserId?: string;
}

export interface SessionRepository {
  create(record: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | undefined>;
  save(record: SessionRecord): Promise<void>;
  list(): Promise<SessionRecord[]>;
  /**
   * Reconciles actions that were still pending or running the last time the
   * process stopped, turning them into failed/interrupted actions while
   * keeping the full event history. Safe to call repeatedly.
   */
  recoverInterruptedSessions(): Promise<void>;
}

function deriveLatestActions(record: SessionRecord) {
  let session = createSessionState({ id: record.id, projectId: record.bootstrap.projectId });
  for (const event of record.events) {
    session = applyAgentEvent(session, event);
  }
  return session.actions;
}

export function createMemorySessionRepository(): SessionRepository {
  const records = new Map<string, SessionRecord>();

  return {
    async create(record) {
      records.set(record.id, record);
    },
    async get(id) {
      return records.get(id);
    },
    async save(record) {
      records.set(record.id, record);
    },
    async list() {
      return [...records.values()];
    },
    async recoverInterruptedSessions() {
      for (const record of records.values()) {
        const recoveryEvents = recoverInterruptedActions(deriveLatestActions(record));
        if (recoveryEvents.length > 0) {
          record.events = [...record.events, ...recoveryEvents];
        }
      }
    },
  };
}

export interface SessionRepositoryFileSystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.definitionId === "string" &&
    Boolean(candidate.bootstrap) &&
    typeof candidate.bootstrap === "object" &&
    Array.isArray(candidate.events) &&
    Boolean(candidate.webEditor) &&
    typeof candidate.webEditor === "object"
  );
}

async function backupCorruptedFile(
  filePath: string,
  fileSystem: SessionRepositoryFileSystem,
  rawContents: string,
): Promise<string> {
  const backupPath = `${filePath}.corrupted-${Date.now()}`;
  await fileSystem.writeFile(backupPath, rawContents, "utf8");
  return backupPath;
}

async function loadPersistedRecords(
  filePath: string,
  fileSystem: SessionRepositoryFileSystem,
): Promise<SessionRecord[]> {
  let rawContents: string;
  try {
    rawContents = await fileSystem.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContents);
  } catch {
    const backupPath = await backupCorruptedFile(filePath, fileSystem, rawContents);
    // eslint-disable-next-line no-console
    console.error(
      `[session-repository] ${filePath} contained malformed JSON and was backed up to ${backupPath}; starting with no persisted sessions.`,
    );
    return [];
  }

  if (!Array.isArray(parsed)) {
    const backupPath = await backupCorruptedFile(filePath, fileSystem, rawContents);
    // eslint-disable-next-line no-console
    console.error(
      `[session-repository] ${filePath} did not contain a session array and was backed up to ${backupPath}; starting with no persisted sessions.`,
    );
    return [];
  }

  const validRecords = parsed.filter(isSessionRecord);
  const droppedCount = parsed.length - validRecords.length;
  if (droppedCount > 0) {
    const backupPath = await backupCorruptedFile(filePath, fileSystem, rawContents);
    // eslint-disable-next-line no-console
    console.error(
      `[session-repository] ${filePath} contained ${droppedCount} invalid session record(s); the original file was backed up to ${backupPath} and the invalid records were dropped.`,
    );
  }

  return validRecords;
}

export async function createFileSessionRepository(
  filePath: string,
  fileSystem: SessionRepositoryFileSystem = fs,
): Promise<SessionRepository> {
  const memory = createMemorySessionRepository();
  let writeChain = Promise.resolve();
  let writeSequence = 0;

  const stored = await loadPersistedRecords(filePath, fileSystem);
  for (const record of stored) await memory.create(record);

  async function flush(): Promise<void> {
    const task = writeChain.then(async () => {
      const records = await memory.list();
      await fileSystem.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.${writeSequence++}.tmp`;
      await fileSystem.writeFile(temporaryPath, JSON.stringify(records), "utf8");
      await fileSystem.rename(temporaryPath, filePath);
    });
    // A rejected task must not permanently poison the chain: later flushes
    // still need to run in order even if an earlier write failed.
    writeChain = task.catch(() => undefined);
    await task;
  }

  return {
    async create(record) {
      await memory.create(record);
      await flush();
    },
    get: (id) => memory.get(id),
    async save(record) {
      await memory.save(record);
      await flush();
    },
    list: () => memory.list(),
    async recoverInterruptedSessions() {
      await memory.recoverInterruptedSessions();
      await flush();
    },
  };
}
import fs from "node:fs/promises";
import path from "node:path";
