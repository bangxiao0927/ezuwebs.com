/**
 * The port every runtime operation goes through. `DockerCliEngine` is the
 * production implementation (shells out to the `docker` CLI, never a
 * shell); `FakeDockerEngine` (test-support) is an in-memory stand-in with
 * no container isolation, used only to exercise the HTTP contract in
 * tests.
 */
export interface RuntimeContainerSpec {
  runtimeId: string;
  image: string;
  labels: Record<string, string>;
  memoryBytes: number;
  cpus: number;
  pidsLimit: number;
  /** Whether /workspace should be mounted exec (default false: noexec). */
  workspaceExec: boolean;
}

export interface ManagedContainerInfo {
  containerId: string;
  runtimeId: string;
  labels: Record<string, string>;
  running: boolean;
}

export interface CommandExecOptions {
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CommandExecResult {
  exitCode: number | undefined;
  timedOut: boolean;
  cancelled: boolean;
  oomKilled: boolean;
  truncated: boolean;
}

export interface CommandHandle {
  onOutput(cb: (stream: "stdout" | "stderr", chunk: string) => void): void;
  onExit(cb: (result: CommandExecResult) => void): void;
  cancel(): Promise<void>;
}

export interface DockerEngine {
  /** Throws unless the docker daemon this engine talks to is running rootless. */
  assertRootless(): Promise<void>;
  createContainer(spec: RuntimeContainerSpec): Promise<{ containerId: string }>;
  startContainer(containerId: string): Promise<void>;
  stopContainer(containerId: string, timeoutSec: number): Promise<void>;
  removeContainer(containerId: string, force: boolean): Promise<void>;
  /**
   * Guarantees no process started inside this container survives, by
   * stopping (and if necessary killing) the whole container rather than
   * trying to signal an individual `docker exec`'d process. Callers that
   * use this must treat the container as gone afterwards.
   */
  terminateContainer(containerId: string): Promise<void>;
  /** Lists only containers carrying this worker's `managed-by` label. */
  listManagedContainers(): Promise<ManagedContainerInfo[]>;
  readFile(containerId: string, path: string): Promise<Buffer | undefined>;
  writeFile(containerId: string, path: string, content: Buffer): Promise<void>;
  deleteFile(containerId: string, path: string): Promise<void>;
  listFiles(containerId: string, root: string): Promise<string[]>;
  execCommand(containerId: string, argv: string[], options: CommandExecOptions): CommandHandle;
}
