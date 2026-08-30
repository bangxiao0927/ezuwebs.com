import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type RuntimeStatus = "creating" | "ready" | "stopping" | "stopped" | "failed";

export class RuntimeCapacityError extends Error {}

export interface RuntimeRecord {
  runtimeId: string;
  sessionId: string;
  projectId: string;
  image: string;
  profile: string;
  status: RuntimeStatus;
  containerId?: string;
  createdAt: string;
  expiresAt?: string;
  /**
   * Set only while `status` is "creating". Past this instant, a `creating`
   * record is stuck: either its owning process crashed/restarted before
   * finishing, or a docker operation hung well past its own timeout. Ignored
   * once `status` moves away from "creating".
   */
  createDeadlineAt?: string;
}

export interface CreateRuntimeInput {
  sessionId: string;
  projectId: string;
  image: string;
  profile: string;
}

const activeStatuses: RuntimeStatus[] = ["creating", "ready", "stopping"];

export interface RuntimeRegistryOptions {
  maxRuntimes?: number;
  createTimeoutMs?: number;
}

const defaultCreateTimeoutMs = 60_000;

/**
 * Persists runtime metadata as one JSON file, written atomically (temp file
 * + rename) so a crash mid-write never leaves a corrupt registry. Enforces
 * at most one active (creating/ready/stopping) runtime per session:
 * `create()` is safe to call more than once for the same session. Also
 * enforces a global cap on active runtimes: the count is read and the new
 * record inserted with no `await` in between, so concurrent `create()`
 * calls within this process can never together exceed `maxRuntimes`.
 */
export class RuntimeRegistry {
  private records = new Map<string, RuntimeRecord>();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly maxRuntimes: number;
  private readonly createTimeoutMs: number;

  constructor(
    private readonly filePath: string,
    options: RuntimeRegistryOptions = {},
  ) {
    this.maxRuntimes = options.maxRuntimes ?? Number.POSITIVE_INFINITY;
    this.createTimeoutMs = options.createTimeoutMs ?? defaultCreateTimeoutMs;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { runtimes: RuntimeRecord[] };
      this.records = new Map(parsed.runtimes.map((record) => [record.runtimeId, record]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.records = new Map();
    }
    this.loaded = true;
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error("RuntimeRegistry.load() must be called before use");
    }
  }

  private async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
      const payload = JSON.stringify({ runtimes: [...this.records.values()] }, null, 2);
      await writeFile(tempPath, payload, "utf8");
      await rename(tempPath, this.filePath);
    });
    await this.writeQueue;
  }

  private findActiveForSession(sessionId: string): RuntimeRecord | undefined {
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId && activeStatuses.includes(record.status)) {
        return record;
      }
    }
    return undefined;
  }

  async create(input: CreateRuntimeInput): Promise<RuntimeRecord> {
    this.assertLoaded();
    const existing = this.findActiveForSession(input.sessionId);
    if (existing) {
      return existing;
    }

    const activeCount = [...this.records.values()].filter((record) => activeStatuses.includes(record.status)).length;
    if (activeCount >= this.maxRuntimes) {
      throw new RuntimeCapacityError(`Runtime capacity of ${this.maxRuntimes} active runtimes is reached`);
    }

    const record: RuntimeRecord = {
      runtimeId: `rt_${randomUUID()}`,
      sessionId: input.sessionId,
      projectId: input.projectId,
      image: input.image,
      profile: input.profile,
      status: "creating",
      createdAt: new Date().toISOString(),
      createDeadlineAt: new Date(Date.now() + this.createTimeoutMs).toISOString(),
    };
    this.records.set(record.runtimeId, record);
    await this.persist();
    return record;
  }

  get(runtimeId: string): RuntimeRecord | undefined {
    this.assertLoaded();
    return this.records.get(runtimeId);
  }

  list(): RuntimeRecord[] {
    this.assertLoaded();
    return [...this.records.values()];
  }

  async update(runtimeId: string, patch: Partial<Omit<RuntimeRecord, "runtimeId">>): Promise<RuntimeRecord> {
    this.assertLoaded();
    const existing = this.records.get(runtimeId);
    if (!existing) {
      throw new Error(`Unknown runtime: ${runtimeId}`);
    }
    const updated = { ...existing, ...patch };
    this.records.set(runtimeId, updated);
    await this.persist();
    return updated;
  }

  async setStatus(runtimeId: string, status: RuntimeStatus): Promise<RuntimeRecord> {
    return this.update(runtimeId, { status });
  }

  async remove(runtimeId: string): Promise<void> {
    this.assertLoaded();
    this.records.delete(runtimeId);
    await this.persist();
  }
}
