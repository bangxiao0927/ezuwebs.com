import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildCreateContainerArgs } from "./container-args.js";
import type {
  CommandExecOptions,
  CommandExecResult,
  CommandHandle,
  DockerEngine,
  ManagedContainerInfo,
  RuntimeContainerSpec,
} from "./engine.js";
import { assertRootlessFromDockerInfo } from "./rootless-check.js";

export const MANAGED_BY_LABEL = "com.ezu.managed-by";
export const MANAGED_BY_VALUE = "runtime-worker";

export interface DockerCliEngineOptions {
  dockerBin: string;
  /** Scratch directory for staging files copied via `docker cp`; each transfer gets its own 0600 temp file, deleted immediately after use. */
  scratchRoot: string;
}

/**
 * Production DockerEngine. Every docker invocation is `spawn(dockerBin,
 * args, { shell: false })`: no argument is ever concatenated into a shell
 * string. `dockerBin` comes only from startup config, never from a
 * request.
 */
export class DockerCliEngine implements DockerEngine {
  constructor(private readonly options: DockerCliEngineOptions) {}

  private run(args: string[], input?: Buffer): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.dockerBin, args, { shell: false });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", reject);
      child.on("close", (exitCode) => {
        resolve({ stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks), exitCode: exitCode ?? -1 });
      });
      if (input) {
        child.stdin.end(input);
      } else {
        child.stdin.end();
      }
    });
  }

  async assertRootless(): Promise<void> {
    const result = await this.run(["info", "--format", "{{json .}}"]);
    assertRootlessFromDockerInfo(result.stdout.toString("utf8"));
  }

  async createContainer(spec: RuntimeContainerSpec): Promise<{ containerId: string }> {
    const args = buildCreateContainerArgs({
      ...spec,
      labels: { ...spec.labels, [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
    });
    const result = await this.run(args);
    if (result.exitCode !== 0) {
      throw new Error("docker create failed");
    }
    return { containerId: result.stdout.toString("utf8").trim() };
  }

  async startContainer(containerId: string): Promise<void> {
    const result = await this.run(["start", containerId]);
    if (result.exitCode !== 0) {
      throw new Error("docker start failed");
    }
  }

  async stopContainer(containerId: string, timeoutSec: number): Promise<void> {
    await this.run(["stop", "--time", `${timeoutSec}`, containerId]);
  }

  async removeContainer(containerId: string, force: boolean): Promise<void> {
    const args = ["rm", ...(force ? ["--force"] : []), containerId];
    await this.run(args);
  }

  /**
   * The only way this engine stops a running command: it never tries to
   * signal an individual `docker exec`'d process (killing the CLI client
   * does not kill it), it stops the whole container. `docker stop` sends
   * SIGTERM and, after the timeout, SIGKILL to every process in the
   * container; the follow-up `rm --force` guarantees the container is gone
   * even if `stop` could not reach it.
   */
  async terminateContainer(containerId: string): Promise<void> {
    await this.run(["stop", "--time", "2", containerId]);
    await this.run(["rm", "--force", containerId]);
  }

  async listManagedContainers(): Promise<ManagedContainerInfo[]> {
    const result = await this.run([
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      `label=${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
      "--format",
      "{{json .}}",
    ]);
    const lines = result.stdout.toString("utf8").split("\n").filter((line) => line.trim().length > 0);
    return lines.map((line) => {
      const parsed = JSON.parse(line) as { ID: string; Labels?: string; State?: string };
      const labels: Record<string, string> = {};
      for (const pair of (parsed.Labels ?? "").split(",")) {
        const [key, value] = pair.split("=");
        if (key) {
          labels[key] = value ?? "";
        }
      }
      return {
        containerId: parsed.ID,
        runtimeId: labels["com.ezu.runtime-id"] ?? "",
        labels,
        running: parsed.State === "running",
      };
    });
  }

  private async withScratchFile<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(this.options.scratchRoot, "cp-"));
    const filePath = path.join(dir, randomUUID());
    try {
      return await fn(filePath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async readFile(containerId: string, workspacePath: string): Promise<Buffer | undefined> {
    return this.withScratchFile(async (filePath) => {
      // `-L` makes docker copy the *target* of a symlink inside the container's
      // /workspace, never the symlink itself: without it, a workspace symlink
      // would land on the host as a symlink at `filePath`, and a plain
      // `readFile` would then follow it off the scratch root.
      const result = await this.run(["cp", "-L", `${containerId}:/workspace/${workspacePath}`, filePath]);
      if (result.exitCode !== 0) {
        return undefined;
      }
      return this.readScratchFileSafely(filePath);
    });
  }

  /**
   * Defense in depth on top of `-L`: refuses to read the scratch path if it
   * turns out to be anything other than a regular file, or if it resolves
   * outside the scratch root, rather than trusting that `docker cp -L`
   * behaved as documented.
   */
  private async readScratchFileSafely(filePath: string): Promise<Buffer> {
    const stat = await lstat(filePath);
    if (!stat.isFile()) {
      throw new Error("docker cp produced something other than a regular file at the scratch path");
    }
    const realFilePath = await realpath(filePath);
    const realScratchRoot = await realpath(this.options.scratchRoot);
    const isInsideScratchRoot =
      realFilePath === realScratchRoot || realFilePath.startsWith(`${realScratchRoot}${path.sep}`);
    if (!isInsideScratchRoot) {
      throw new Error("docker cp resolved outside the configured scratch root");
    }
    return readFile(filePath);
  }

  async writeFile(containerId: string, workspacePath: string, content: Buffer): Promise<void> {
    await this.withScratchFile(async (filePath) => {
      // O_NOFOLLOW is best-effort hardening against a symlink appearing at
      // this freshly minted scratch path before we open it; scratchRoot is a
      // private (0700), per-transfer mkdtemp directory, so this is
      // defense-in-depth, not the primary protection.
      const handle = await open(
        filePath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
      const result = await this.run(["cp", filePath, `${containerId}:/workspace/${workspacePath}`]);
      if (result.exitCode !== 0) {
        throw new Error("docker cp (write) failed");
      }
    });
  }

  async deleteFile(containerId: string, workspacePath: string): Promise<void> {
    await this.run(["exec", containerId, "rm", "-f", `/workspace/${workspacePath}`]);
  }

  async listFiles(containerId: string, root: string): Promise<string[]> {
    const result = await this.run(["exec", containerId, "find", `/workspace/${root}`, "-type", "f"]);
    if (result.exitCode !== 0) {
      return [];
    }
    return result.stdout
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.replace(/^\/workspace\//, ""));
  }

  execCommand(containerId: string, argv: string[], options: CommandExecOptions): CommandHandle {
    const outputListeners = new Set<(stream: "stdout" | "stderr", chunk: string) => void>();
    const exitListeners = new Set<(result: CommandExecResult) => void>();
    const args = ["exec", ...(options.cwd ? ["--workdir", `/workspace/${options.cwd}`] : []), containerId, ...argv];
    const child = spawn(this.options.dockerBin, args, { shell: false });
    let outputBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    const emit = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (truncated) {
        return;
      }
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) {
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      for (const listener of outputListeners) {
        listener(stream, chunk.toString("utf8"));
      }
    };

    child.stdout.on("data", (chunk: Buffer) => emit("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => emit("stderr", chunk));
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const result: CommandExecResult = {
        exitCode: exitCode === null ? undefined : exitCode,
        timedOut,
        cancelled,
        oomKilled: false,
        truncated,
      };
      for (const listener of exitListeners) {
        listener(result);
      }
    });

    return {
      onOutput(cb) {
        outputListeners.add(cb);
      },
      onExit(cb) {
        exitListeners.add(cb);
      },
      async cancel() {
        clearTimeout(timer);
        cancelled = true;
        child.kill("SIGKILL");
      },
    };
  }
}
