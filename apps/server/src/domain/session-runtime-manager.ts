import { type RuntimeAdapter } from "@ezu/core";
import { createBrowserRuntimeStub } from "@ezu/runtime-browser";

import { type WorkspaceFileEntry } from "./workspace.js";

export interface SessionRuntimeManagerOptions {
  /** How long a session's runtime may sit unused before {@link SessionRuntimeManager.evictIdle} may drop it. */
  idleTtlMs?: number;
  /** Injectable clock, so idle-eviction tests can control elapsed time without real timers. */
  now?: () => number;
  /** Injectable runtime factory, defaults to the in-process browser runtime stub. */
  createRuntime?: (seedFiles: WorkspaceFileEntry[]) => RuntimeAdapter;
}

export interface SessionRuntimeManager {
  /**
   * Runs `operation` against the session's runtime, creating and seeding it
   * on first use and reusing the same instance (and its accumulated state)
   * on later calls. Operations for one session always run one at a time;
   * operations for different sessions run fully in parallel. Resolves with
   * the operation's result plus a full snapshot of the runtime's files
   * taken immediately after the operation settles.
   */
  withRuntime<T>(
    sessionId: string,
    seedFiles: WorkspaceFileEntry[],
    operation: (runtime: RuntimeAdapter) => Promise<T>,
  ): Promise<{ result: T; workspaceFiles: WorkspaceFileEntry[] }>;
  /** Drops every session whose runtime has been idle past the configured TTL. Busy sessions are left untouched. */
  evictIdle(): void;
  /** Removes a session's runtime once any in-flight operation for it settles. Its next use starts from a fresh, re-seeded runtime. */
  dispose(sessionId: string): Promise<void>;
  /** Disposes every session's runtime. */
  disposeAll(): Promise<void>;
}

const defaultIdleTtlMs = 15 * 60 * 1000;

interface RuntimeEntry {
  runtime: RuntimeAdapter;
  lastUsedAt: number;
  pendingCount: number;
  queue: Promise<void>;
}

async function snapshotWorkspaceFiles(runtime: RuntimeAdapter): Promise<WorkspaceFileEntry[]> {
  const paths = await runtime.listFiles("");
  return Promise.all(paths.map(async (path) => ({ path, content: await runtime.readFile(path) })));
}

export function createSessionRuntimeManager(
  options: SessionRuntimeManagerOptions = {},
): SessionRuntimeManager {
  const idleTtlMs = options.idleTtlMs ?? defaultIdleTtlMs;
  const now = options.now ?? (() => Date.now());
  const createRuntime = options.createRuntime ?? ((seedFiles) => createBrowserRuntimeStub(seedFiles));
  const entries = new Map<string, RuntimeEntry>();

  function getOrCreateEntry(sessionId: string, seedFiles: WorkspaceFileEntry[]): RuntimeEntry {
    const existing = entries.get(sessionId);
    if (existing) {
      return existing;
    }

    const entry: RuntimeEntry = {
      runtime: createRuntime(seedFiles),
      lastUsedAt: now(),
      pendingCount: 0,
      queue: Promise.resolve(),
    };
    entries.set(sessionId, entry);
    return entry;
  }

  async function dispose(sessionId: string): Promise<void> {
    const entry = entries.get(sessionId);
    if (!entry) {
      return;
    }
    // Wait for any in-flight (or queued) operation to settle rather than
    // dropping the runtime out from under it.
    await entry.queue;
    if (entries.get(sessionId) === entry) {
      entries.delete(sessionId);
    }
  }

  return {
    async withRuntime(sessionId, seedFiles, operation) {
      const entry = getOrCreateEntry(sessionId, seedFiles);
      entry.pendingCount += 1;

      let result!: { result: unknown; workspaceFiles: WorkspaceFileEntry[] };
      const task = entry.queue.then(async () => {
        const operationResult = await operation(entry.runtime);
        const workspaceFiles = await snapshotWorkspaceFiles(entry.runtime);
        result = { result: operationResult, workspaceFiles };
      });
      entry.queue = task.then(
        () => undefined,
        () => undefined,
      );

      try {
        await task;
        return result as { result: Awaited<ReturnType<typeof operation>>; workspaceFiles: WorkspaceFileEntry[] };
      } finally {
        entry.pendingCount -= 1;
        entry.lastUsedAt = now();
      }
    },

    evictIdle() {
      for (const [sessionId, entry] of entries) {
        if (entry.pendingCount === 0 && now() - entry.lastUsedAt >= idleTtlMs) {
          entries.delete(sessionId);
        }
      }
    },

    dispose,

    async disposeAll() {
      await Promise.all([...entries.keys()].map((sessionId) => dispose(sessionId)));
    },
  };
}
