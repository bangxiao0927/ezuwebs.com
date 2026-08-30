import { type AgentEvent } from "@ezu/protocol";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface RunRecord {
  id: string;
  sessionId: string;
  userId?: string;
  kind: string;
  status: RunStatus;
  input: unknown;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelRequested: boolean;
  version: number;
}

export interface RunEventRecord {
  seq: number;
  event: AgentEvent;
}

export interface CreateRunInput {
  id: string;
  sessionId: string;
  userId?: string;
  kind: string;
  input: unknown;
}

export class RunNotFoundError extends Error {}
export class RunAlreadyExistsError extends Error {}
export class RunVersionConflictError extends Error {}
export class RunNotQueuedError extends Error {}

export interface RunRepository {
  create(input: CreateRunInput): Promise<RunRecord>;
  get(id: string): Promise<RunRecord | undefined>;
  /** Transitions a queued run to running. Throws RunNotQueuedError if it is not queued. */
  claim(id: string): Promise<RunRecord>;
  /** Appends an event with the next sequence number for this run. Seq allocation never repeats. */
  appendEvent(runId: string, event: AgentEvent): Promise<RunEventRecord>;
  /** Flags cancellation on a run. Idempotent; a no-op once the run is already terminal. */
  requestCancel(id: string): Promise<RunRecord>;
  complete(id: string, expectedVersion: number): Promise<RunRecord>;
  fail(id: string, expectedVersion: number, error: string): Promise<RunRecord>;
  cancel(id: string, expectedVersion: number): Promise<RunRecord>;
  listEventsAfter(runId: string, afterSeq: number): Promise<RunEventRecord[]>;
  /** Highest seq recorded for a run, without reading any event rows. */
  getLastEventSeq(runId: string): Promise<number>;
  /** Runs still marked "running" from a previous process lifetime. */
  listRunningRuns(): Promise<RunRecord[]>;
  /** Runs still marked "queued" from a previous process lifetime, recoverable on restart. */
  listQueuedRuns(): Promise<RunRecord[]>;
  /** All runs recorded for a session, newest first. */
  listRunsForSession(sessionId: string): Promise<RunRecord[]>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createMemoryRunRepository(): RunRepository {
  const runs = new Map<string, RunRecord>();
  const events = new Map<string, AgentEvent[]>();

  function requireRun(id: string): RunRecord {
    const run = runs.get(id);
    if (!run) throw new RunNotFoundError(`Unknown run: ${id}`);
    return run;
  }

  function checkVersion(run: RunRecord, expectedVersion: number): void {
    if (run.version !== expectedVersion) {
      throw new RunVersionConflictError(`Run ${run.id} was modified concurrently`);
    }
  }

  function transitionToTerminal(
    id: string,
    expectedVersion: number,
    status: Extract<RunStatus, "completed" | "failed" | "cancelled">,
    error?: string,
  ): RunRecord {
    const run = requireRun(id);
    checkVersion(run, expectedVersion);
    const updated: RunRecord = {
      ...run,
      status,
      completedAt: nowIso(),
      version: run.version + 1,
      ...(error !== undefined ? { error } : {}),
    };
    runs.set(id, updated);
    return updated;
  }

  return {
    async create(input) {
      if (runs.has(input.id)) {
        throw new RunAlreadyExistsError(`Run already exists: ${input.id}`);
      }
      const record: RunRecord = {
        id: input.id,
        sessionId: input.sessionId,
        ...(input.userId ? { userId: input.userId } : {}),
        kind: input.kind,
        status: "queued",
        input: input.input,
        createdAt: nowIso(),
        cancelRequested: false,
        version: 1,
      };
      runs.set(record.id, record);
      events.set(record.id, []);
      return record;
    },

    async get(id) {
      return runs.get(id);
    },

    async claim(id) {
      const run = requireRun(id);
      if (run.status !== "queued") {
        throw new RunNotQueuedError(`Run ${id} is not queued (status: ${run.status})`);
      }
      const updated: RunRecord = {
        ...run,
        status: "running",
        startedAt: nowIso(),
        version: run.version + 1,
      };
      runs.set(id, updated);
      return updated;
    },

    async appendEvent(runId, event) {
      requireRun(runId);
      const list = events.get(runId) ?? [];
      const seq = list.length + 1;
      list.push(event);
      events.set(runId, list);
      return { seq, event };
    },

    async requestCancel(id) {
      const run = requireRun(id);
      if (run.cancelRequested || run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
        return run;
      }
      const updated: RunRecord = { ...run, cancelRequested: true, version: run.version + 1 };
      runs.set(id, updated);
      return updated;
    },

    async complete(id, expectedVersion) {
      return transitionToTerminal(id, expectedVersion, "completed");
    },

    async fail(id, expectedVersion, error) {
      return transitionToTerminal(id, expectedVersion, "failed", error);
    },

    async cancel(id, expectedVersion) {
      return transitionToTerminal(id, expectedVersion, "cancelled");
    },

    async listEventsAfter(runId, afterSeq) {
      const list = events.get(runId) ?? [];
      return list
        .map((event, index) => ({ seq: index + 1, event }))
        .filter((entry) => entry.seq > afterSeq);
    },

    async getLastEventSeq(runId) {
      const list = events.get(runId) ?? [];
      return list.length;
    },

    async listRunningRuns() {
      return [...runs.values()].filter((run) => run.status === "running");
    },

    async listQueuedRuns() {
      return [...runs.values()].filter((run) => run.status === "queued");
    },

    async listRunsForSession(sessionId) {
      return [...runs.values()]
        .filter((run) => run.sessionId === sessionId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  };
}
