import { createHash } from "node:crypto";

import type { DockerEngine } from "../docker/engine.js";
import { validateWorkspacePath } from "./path-validation.js";

export class WorkspaceNotFoundError extends Error {}
export class WorkspaceConflictError extends Error {}
export class WorkspaceQuotaError extends Error {}

export interface WorkspaceLimits {
  maxFileBytes: number;
  maxFileCount: number;
  maxTotalBytes: number;
}

export interface WriteFileOptions {
  expectedVersion?: string;
}

export interface ListFilesOptions {
  limit?: number;
  cursor?: string;
}

function versionOf(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

interface ContainerUsage {
  fileBytes: Map<string, number>;
}

/**
 * Re-validates every path and enforces file/count/byte quotas before any
 * workspace operation reaches the DockerEngine. Quota accounting lives in
 * this process's memory, scoped per container: it is not recovered across a
 * worker restart, which is acceptable because a restart also runs orphan
 * reconciliation on the underlying containers.
 */
export class WorkspaceService {
  private readonly usage = new Map<string, ContainerUsage>();

  constructor(
    private readonly engine: DockerEngine,
    private readonly limits: WorkspaceLimits,
  ) {}

  private usageFor(containerId: string): ContainerUsage {
    let usage = this.usage.get(containerId);
    if (!usage) {
      usage = { fileBytes: new Map() };
      this.usage.set(containerId, usage);
    }
    return usage;
  }

  /** Drops quota bookkeeping for a container whose runtime is gone; the container itself takes the files with it. */
  clearUsage(containerId: string): void {
    this.usage.delete(containerId);
  }

  async readFile(containerId: string, rawPath: string): Promise<{ content: string; version: string }> {
    const path = validateWorkspacePath(rawPath);
    const buffer = await this.engine.readFile(containerId, path);
    if (buffer === undefined) {
      throw new WorkspaceNotFoundError(`No such file: ${path}`);
    }
    return { content: buffer.toString("utf8"), version: versionOf(buffer) };
  }

  async writeFile(
    containerId: string,
    rawPath: string,
    content: string,
    options: WriteFileOptions = {},
  ): Promise<{ version: string }> {
    const path = validateWorkspacePath(rawPath);
    const buffer = Buffer.from(content, "utf8");

    if (buffer.byteLength > this.limits.maxFileBytes) {
      throw new WorkspaceQuotaError(
        `file content of ${buffer.byteLength} bytes exceeds the configured limit of ${this.limits.maxFileBytes}`,
      );
    }

    const usage = this.usageFor(containerId);
    const previousBytes = usage.fileBytes.get(path);

    if (options.expectedVersion !== undefined) {
      const existing = await this.engine.readFile(containerId, path);
      const currentVersion = existing ? versionOf(existing) : undefined;
      if (currentVersion !== options.expectedVersion) {
        throw new WorkspaceConflictError(
          `expectedVersion ${options.expectedVersion} does not match the current version of ${path}`,
        );
      }
    }

    if (previousBytes === undefined && usage.fileBytes.size >= this.limits.maxFileCount) {
      throw new WorkspaceQuotaError(`workspace already has the maximum of ${this.limits.maxFileCount} files`);
    }

    const totalBytes = [...usage.fileBytes.values()].reduce((sum, bytes) => sum + bytes, 0);
    const projectedTotal = totalBytes - (previousBytes ?? 0) + buffer.byteLength;
    if (projectedTotal > this.limits.maxTotalBytes) {
      throw new WorkspaceQuotaError(
        `writing ${path} would bring the workspace to ${projectedTotal} bytes, exceeding the configured limit of ${this.limits.maxTotalBytes}`,
      );
    }

    await this.engine.writeFile(containerId, path, buffer);
    usage.fileBytes.set(path, buffer.byteLength);
    return { version: versionOf(buffer) };
  }

  async patchFile(containerId: string, rawPath: string, patch: string): Promise<{ version: string }> {
    const path = validateWorkspacePath(rawPath);
    const existing = await this.engine.readFile(containerId, path);
    const current = existing ? existing.toString("utf8") : "";
    const next = `${current}\n${patch}`.trim();
    return this.writeFile(containerId, path, next);
  }

  async deleteFile(containerId: string, rawPath: string): Promise<void> {
    const path = validateWorkspacePath(rawPath);
    await this.engine.deleteFile(containerId, path);
    this.usageFor(containerId).fileBytes.delete(path);
  }

  async listFiles(
    containerId: string,
    rawRoot: string,
    options: ListFilesOptions = {},
  ): Promise<{ files: string[]; nextCursor?: string }> {
    const root = validateWorkspacePath(rawRoot, { allowEmpty: true });
    const all = (await this.engine.listFiles(containerId, root)).sort();
    const limit = options.limit ?? 1_000;
    const start = options.cursor ? Number.parseInt(options.cursor, 10) : 0;
    const page = all.slice(start, start + limit);
    const nextCursor = start + limit < all.length ? `${start + limit}` : undefined;
    return nextCursor === undefined ? { files: page } : { files: page, nextCursor };
  }

  async snapshotFiles(containerId: string): Promise<{ files: { path: string; content: string }[] }> {
    const { files } = await this.listFiles(containerId, "", { limit: this.limits.maxFileCount });
    const snapshot = await Promise.all(
      files.map(async (path) => ({ path, content: (await this.readFile(containerId, path)).content })),
    );
    return { files: snapshot };
  }
}
