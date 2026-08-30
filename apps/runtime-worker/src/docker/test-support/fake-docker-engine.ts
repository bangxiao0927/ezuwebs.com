import { randomUUID } from "node:crypto";

import type {
  CommandExecOptions,
  CommandExecResult,
  CommandHandle,
  DockerEngine,
  ManagedContainerInfo,
  RuntimeContainerSpec,
} from "../engine.js";

/**
 * An in-memory DockerEngine with no container isolation and no security
 * properties of its own. Exists only to exercise this worker's HTTP
 * contract, registry, and policy logic in tests without ever touching a
 * real docker daemon; it must never be mistaken for a production engine.
 */
export class FakeDockerEngine implements DockerEngine {
  rootless = true;
  readonly containers = new Map<
    string,
    { runtimeId: string; labels: Record<string, string>; running: boolean; files: Map<string, Buffer> }
  >();
  /** Scripted responses for execCommand, keyed by argv.join(" "). */
  readonly scriptedCommands = new Map<string, { exitCode: number; stdout?: string; stderr?: string; delayMs?: number }>();
  /** Every containerId ever passed to terminateContainer(), in call order. */
  readonly terminatedContainerIds: string[] = [];
  /** The options passed to the most recent execCommand() call, for assertions on validated/clamped limits. */
  lastExecOptions: CommandExecOptions | undefined;

  async assertRootless(): Promise<void> {
    if (!this.rootless) {
      throw new Error("fake docker engine configured as not rootless");
    }
  }

  async createContainer(spec: RuntimeContainerSpec): Promise<{ containerId: string }> {
    const containerId = `fake_${randomUUID()}`;
    this.containers.set(containerId, {
      runtimeId: spec.runtimeId,
      labels: spec.labels,
      running: false,
      files: new Map(),
    });
    return { containerId };
  }

  async startContainer(containerId: string): Promise<void> {
    const container = this.containers.get(containerId);
    if (container) {
      container.running = true;
    }
  }

  async stopContainer(containerId: string): Promise<void> {
    const container = this.containers.get(containerId);
    if (container) {
      container.running = false;
    }
  }

  async removeContainer(containerId: string): Promise<void> {
    this.containers.delete(containerId);
  }

  async terminateContainer(containerId: string): Promise<void> {
    this.terminatedContainerIds.push(containerId);
    this.containers.delete(containerId);
  }

  async listManagedContainers(): Promise<ManagedContainerInfo[]> {
    return [...this.containers.entries()].map(([containerId, container]) => ({
      containerId,
      runtimeId: container.runtimeId,
      labels: container.labels,
      running: container.running,
    }));
  }

  async readFile(containerId: string, path: string): Promise<Buffer | undefined> {
    return this.containers.get(containerId)?.files.get(path);
  }

  async writeFile(containerId: string, path: string, content: Buffer): Promise<void> {
    const container = this.containers.get(containerId);
    if (!container) {
      throw new Error(`unknown container ${containerId}`);
    }
    container.files.set(path, content);
  }

  async deleteFile(containerId: string, path: string): Promise<void> {
    this.containers.get(containerId)?.files.delete(path);
  }

  async listFiles(containerId: string, root: string): Promise<string[]> {
    const container = this.containers.get(containerId);
    if (!container) {
      return [];
    }
    const prefix = root.length > 0 ? `${root}/` : "";
    return [...container.files.keys()].filter((path) => path.startsWith(prefix));
  }

  execCommand(containerId: string, argv: string[], options: CommandExecOptions): CommandHandle {
    this.lastExecOptions = options;
    const outputListeners = new Set<(stream: "stdout" | "stderr", chunk: string) => void>();
    const exitListeners = new Set<(result: CommandExecResult) => void>();
    let cancelled = false;
    let settled = false;

    const script = this.scriptedCommands.get(argv.join(" "));
    const delayMs = script?.delayMs ?? 0;
    const timeoutMs = options.timeoutMs;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      finish({ exitCode: undefined, timedOut: true, cancelled: false, oomKilled: false, truncated: false });
    }, timeoutMs);

    const finish = (result: CommandExecResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      for (const listener of exitListeners) {
        listener(result);
      }
    };

    setTimeout(() => {
      if (cancelled || settled || timedOut) {
        return;
      }
      if (script?.stdout) {
        for (const listener of outputListeners) {
          listener("stdout", script.stdout);
        }
      }
      if (script?.stderr) {
        for (const listener of outputListeners) {
          listener("stderr", script.stderr);
        }
      }
      finish({ exitCode: script?.exitCode ?? 0, timedOut: false, cancelled: false, oomKilled: false, truncated: false });
    }, delayMs);

    return {
      onOutput(cb) {
        outputListeners.add(cb);
      },
      onExit(cb) {
        exitListeners.add(cb);
      },
      async cancel() {
        cancelled = true;
        finish({ exitCode: undefined, timedOut: false, cancelled: true, oomKilled: false, truncated: false });
      },
    };
  }
}
