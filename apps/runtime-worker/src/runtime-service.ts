import { createHash } from "node:crypto";

import type { DockerEngine } from "./docker/engine.js";
import type { ManagedContainerInfo } from "./docker/engine.js";
import { CommandService, type CreateCommandInput } from "./commands/command-service.js";
import { RuntimeEventLog } from "./events/event-log.js";
import { PreviewService } from "./preview/preview-service.js";
import { RuntimeRegistry, type RuntimeRecord } from "./registry/runtime-registry.js";
import { WorkspaceService } from "./workspace/workspace-service.js";

export { RuntimeCapacityError } from "./registry/runtime-registry.js";

export class RuntimeServiceError extends Error {}
export class RuntimeNotFoundError extends RuntimeServiceError {}
export class ImageNotAllowedError extends RuntimeServiceError {}

export interface RuntimeServiceOptions {
  allowedImages: string[];
  memoryBytes: number;
  cpus: number;
  pidsLimit: number;
  runtimeTtlMs: number;
}

export interface CreateRuntimeInput {
  sessionId: string;
  projectId: string;
  image: string;
  profile: string;
  seed?: { files: { path: string; content: string }[] };
}

function sessionHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

/**
 * Composes the registry, engine, workspace, command, and preview services
 * into the operations the HTTP router exposes. This is the only place that
 * turns a runtimeId into a containerId, so every HTTP handler is forced
 * through the registry's ownership check.
 */
export class RuntimeService {
  private readonly eventLogs = new Map<string, RuntimeEventLog>();

  constructor(
    private readonly engine: DockerEngine,
    private readonly registry: RuntimeRegistry,
    readonly workspace: WorkspaceService,
    readonly commands: CommandService,
    private readonly preview: PreviewService,
    private readonly options: RuntimeServiceOptions,
  ) {}

  private eventLogFor(runtimeId: string): RuntimeEventLog {
    let log = this.eventLogs.get(runtimeId);
    if (!log) {
      log = new RuntimeEventLog();
      this.eventLogs.set(runtimeId, log);
    }
    return log;
  }

  requireRuntime(runtimeId: string): RuntimeRecord {
    const record = this.registry.get(runtimeId);
    if (!record) {
      throw new RuntimeNotFoundError(`Unknown runtime: ${runtimeId}`);
    }
    return record;
  }

  private requireContainerId(runtimeId: string): { record: RuntimeRecord; containerId: string } {
    const record = this.requireRuntime(runtimeId);
    if (!record.containerId) {
      throw new RuntimeNotFoundError(`Runtime ${runtimeId} has no container yet`);
    }
    return { record, containerId: record.containerId };
  }

  async createRuntime(input: CreateRuntimeInput): Promise<{ runtimeId: string; sessionId: string; status: string }> {
    if (!this.options.allowedImages.includes(input.image)) {
      throw new ImageNotAllowedError(`Image ${input.image} is not in the configured allowlist`);
    }

    const record = await this.registry.create({
      sessionId: input.sessionId,
      projectId: input.projectId,
      image: input.image,
      profile: input.profile,
    });

    if (record.containerId) {
      return { runtimeId: record.runtimeId, sessionId: record.sessionId, status: record.status };
    }

    let containerId: string | undefined;
    try {
      const created = await this.engine.createContainer({
        runtimeId: record.runtimeId,
        image: input.image,
        labels: {
          "com.ezu.runtime-id": record.runtimeId,
          "com.ezu.session-hash": sessionHash(input.sessionId),
        },
        memoryBytes: this.options.memoryBytes,
        cpus: this.options.cpus,
        pidsLimit: this.options.pidsLimit,
        workspaceExec: false,
      });
      containerId = created.containerId;
      await this.engine.startContainer(containerId);

      for (const file of input.seed?.files ?? []) {
        await this.workspace.writeFile(containerId, file.path, file.content);
      }
    } catch (error) {
      if (containerId) {
        try {
          await this.engine.removeContainer(containerId, true);
        } catch {
          // Best-effort: the registry status change below is what makes this runtime retryable.
        }
      }
      await this.registry.update(record.runtimeId, { status: "failed" });
      this.eventLogFor(record.runtimeId).append({ type: "runtime.failed", message: "runtime creation failed" });
      throw error;
    }

    const expiresAt = new Date(Date.now() + this.options.runtimeTtlMs).toISOString();
    const updated = await this.registry.update(record.runtimeId, { status: "ready", containerId, expiresAt });
    return { runtimeId: updated.runtimeId, sessionId: updated.sessionId, status: updated.status };
  }

  async readFile(runtimeId: string, path: string) {
    const { containerId } = this.requireContainerId(runtimeId);
    return this.workspace.readFile(containerId, path);
  }

  async writeFile(runtimeId: string, path: string, content: string, expectedVersion?: string) {
    const { containerId } = this.requireContainerId(runtimeId);
    const result = await this.workspace.writeFile(
      containerId,
      path,
      content,
      expectedVersion === undefined ? {} : { expectedVersion },
    );
    this.eventLogFor(runtimeId).append({ type: "file.changed", path, changeType: "write" });
    return result;
  }

  async patchFile(runtimeId: string, path: string, patch: string) {
    const { containerId } = this.requireContainerId(runtimeId);
    const result = await this.workspace.patchFile(containerId, path, patch);
    this.eventLogFor(runtimeId).append({ type: "file.changed", path, changeType: "patch" });
    return result;
  }

  async deleteFile(runtimeId: string, path: string) {
    const { containerId } = this.requireContainerId(runtimeId);
    await this.workspace.deleteFile(containerId, path);
    this.eventLogFor(runtimeId).append({ type: "file.changed", path, changeType: "delete" });
  }

  async listFiles(runtimeId: string, root: string, options: { limit?: number; cursor?: string }) {
    const { containerId } = this.requireContainerId(runtimeId);
    return this.workspace.listFiles(containerId, root, options);
  }

  async snapshotFiles(runtimeId: string) {
    const { containerId } = this.requireContainerId(runtimeId);
    return this.workspace.snapshotFiles(containerId);
  }

  createCommand(runtimeId: string, input: CreateCommandInput) {
    const { containerId } = this.requireContainerId(runtimeId);
    return this.commands.create(containerId, input, () => {
      void this.markRuntimeFailed(runtimeId).catch(() => {});
    });
  }

  getCommandStatus(runtimeId: string, commandId: string) {
    const { containerId } = this.requireContainerId(runtimeId);
    return this.commands.getStatus(containerId, commandId);
  }

  getCommandEvents(runtimeId: string, commandId: string, afterSeq: number) {
    const { containerId } = this.requireContainerId(runtimeId);
    return this.commands.getEvents(containerId, commandId, afterSeq);
  }

  cancelCommand(runtimeId: string, commandId: string) {
    const { containerId } = this.requireContainerId(runtimeId);
    return this.commands.cancel(containerId, commandId);
  }

  createPreview(runtimeId: string, port?: number) {
    this.requireContainerId(runtimeId);
    const issued = this.preview.issue(runtimeId, port);
    this.eventLogFor(runtimeId).append({ type: "port.changed", port: issued.port, url: issued.url, status: "open" });
    return issued;
  }

  resolvePreview(token: string) {
    return this.preview.resolve(token);
  }

  getEvents(runtimeId: string, afterSeq: number) {
    this.requireRuntime(runtimeId);
    return this.eventLogFor(runtimeId).getSince(afterSeq);
  }

  listRuntimes(): RuntimeRecord[] {
    return this.registry.list();
  }

  listManagedContainers(): Promise<ManagedContainerInfo[]> {
    return this.engine.listManagedContainers();
  }

  /** Removes a container this worker's own labels identify as managed but that no registry record owns. */
  async terminateUnknownContainer(containerId: string): Promise<void> {
    await this.engine.removeContainer(containerId, true);
  }

  private async cleanupRuntimeState(runtimeId: string, containerId: string | undefined): Promise<void> {
    if (containerId) {
      await this.commands.disposeForContainer(containerId);
      this.workspace.clearUsage(containerId);
    }
    this.preview.disposeForRuntime(runtimeId);
    this.eventLogs.delete(runtimeId);
  }

  /** Marks a runtime failed and drops its in-memory state, without removing it from the registry (unlike deleteRuntime). */
  async markRuntimeFailed(runtimeId: string): Promise<void> {
    const record = this.requireRuntime(runtimeId);
    if (record.containerId) {
      try {
        await this.engine.removeContainer(record.containerId, true);
      } catch {
        // Best-effort: the registry status change below is what makes this runtime retryable.
      }
    }
    await this.cleanupRuntimeState(runtimeId, record.containerId);
    await this.registry.setStatus(runtimeId, "failed");
  }

  async deleteRuntime(runtimeId: string): Promise<void> {
    const record = this.requireRuntime(runtimeId);
    if (record.containerId) {
      await this.engine.stopContainer(record.containerId, 5);
      await this.engine.removeContainer(record.containerId, true);
    }
    await this.cleanupRuntimeState(runtimeId, record.containerId);
    await this.registry.remove(runtimeId);
  }

  /** Stops accepting new work on shutdown: cancels every in-flight command, and disposes every runtime when configured to. */
  async shutdown(options: { disposeAllRuntimes: boolean }): Promise<void> {
    await this.commands.cancelAll();
    if (!options.disposeAllRuntimes) {
      return;
    }
    for (const record of this.registry.list()) {
      try {
        await this.deleteRuntime(record.runtimeId);
      } catch {
        // Best-effort: keep disposing the remaining runtimes even if one fails.
      }
    }
  }
}
