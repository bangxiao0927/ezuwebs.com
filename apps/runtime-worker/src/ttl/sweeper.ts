import type { RuntimeService } from "../runtime-service.js";

const activeStatuses = new Set(["creating", "ready", "stopping"]);

/**
 * Enforces runtime TTLs and reconciles the registry against whatever
 * containers the engine actually reports. Depends only on `RuntimeService`
 * (never the registry or engine directly) so every deletion and cleanup
 * goes through the same path as an HTTP-triggered delete: preview tokens,
 * event logs, command state, and workspace usage all get cleared, not just
 * the container and the registry record.
 */
export class RuntimeSweeper {
  constructor(private readonly runtimeService: RuntimeService) {}

  async sweepExpired(now: number = Date.now()): Promise<void> {
    for (const record of this.runtimeService.listRuntimes()) {
      if (record.status === "creating") {
        if (record.createDeadlineAt && new Date(record.createDeadlineAt).getTime() <= now) {
          await this.runtimeService.markRuntimeFailed(record.runtimeId);
        }
        continue;
      }
      if (!record.expiresAt || !activeStatuses.has(record.status)) {
        continue;
      }
      if (new Date(record.expiresAt).getTime() > now) {
        continue;
      }
      await this.runtimeService.deleteRuntime(record.runtimeId);
    }
  }

  /**
   * Runs once at worker startup, before any request is served. A "creating"
   * record found here cannot belong to an in-flight `createRuntime()` call
   * in this process (this process just started), so it was left behind by a
   * crash or restart. Marks each one failed so its session can retry and its
   * capacity slot is freed; container removal, if it had one, is best-effort
   * inside `markRuntimeFailed`.
   */
  async reconcileStaleCreating(): Promise<void> {
    for (const record of this.runtimeService.listRuntimes()) {
      if (record.status === "creating") {
        await this.runtimeService.markRuntimeFailed(record.runtimeId);
      }
    }
  }

  async reconcileOrphans(): Promise<void> {
    const managedContainers = await this.runtimeService.listManagedContainers();
    const knownContainerIds = new Set(
      this.runtimeService.listRuntimes().map((record) => record.containerId).filter((id): id is string => Boolean(id)),
    );

    for (const container of managedContainers) {
      if (!knownContainerIds.has(container.containerId)) {
        await this.runtimeService.terminateUnknownContainer(container.containerId);
      }
    }

    const liveContainerIds = new Set(managedContainers.map((container) => container.containerId));
    for (const record of this.runtimeService.listRuntimes()) {
      if (!activeStatuses.has(record.status)) {
        continue;
      }
      if (record.containerId && !liveContainerIds.has(record.containerId)) {
        await this.runtimeService.markRuntimeFailed(record.runtimeId);
      }
    }
  }
}
