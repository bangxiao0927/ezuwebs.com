import { applyAgentEvent, createSessionState, recoverInterruptedActions } from "@ezu/core";
import { type AgentEvent } from "@ezu/protocol";

import { type InteractiveWebEditorState, type WebAppBootstrap } from "./view-model.js";

export interface SessionRecord {
  id: string;
  definitionId: string;
  bootstrap: WebAppBootstrap;
  events: AgentEvent[];
  webEditor: InteractiveWebEditorState;
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

export async function createFileSessionRepository(filePath: string): Promise<SessionRepository> {
  const memory = createMemorySessionRepository();
  let writeChain = Promise.resolve();
  let writeSequence = 0;

  try {
    const stored = JSON.parse(await fs.readFile(filePath, "utf8")) as SessionRecord[];
    for (const record of stored) await memory.create(record);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  async function flush(): Promise<void> {
    writeChain = writeChain.then(async () => {
      const records = await memory.list();
      await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.${writeSequence++}.tmp`;
      await fs.writeFile(temporaryPath, JSON.stringify(records), "utf8");
      await fs.rename(temporaryPath, filePath);
    });
    await writeChain;
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
