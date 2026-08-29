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
