import { type RuntimeAdapter, type RuntimeProcess } from "@ezu/core";
import { type RuntimePort } from "@ezu/protocol";
import { type ZodType } from "zod";

import { tokenizeCommand } from "./command-tokenizer.js";
import { type RemoteRuntimeConfig, type RemoteRuntimeConfigInput, validateRemoteRuntimeConfig } from "./config.js";
import {
  RemoteRuntimeError,
  RemoteRuntimePreviewRejectedError,
  RemoteRuntimeProtocolError,
  RemoteRuntimeSessionMismatchError,
  RemoteRuntimeValidationError,
} from "./errors.js";
import { requestRuntimeWorker, type HttpClientOptions } from "./http-client.js";
import { validateWorkspacePath } from "./path-validation.js";
import {
  commandCreateResponseSchema,
  commandEventsResponseSchema,
  commandStatusResponseSchema,
  fileListResponseSchema,
  fileReadResponseSchema,
  fileSnapshotResponseSchema,
  previewResponseSchema,
  runtimeCreateResponseSchema,
  runtimeEventsResponseSchema,
  type CommandEvent,
  type RuntimeEvent,
} from "./worker-protocol.js";

export interface RemoteRuntimeSeedFile {
  path: string;
  content: string;
}

/** Timeout-policy exit code this adapter reports when a command is force-stopped for exceeding its output or wall-clock limits, mirroring the shell convention for a signal-terminated process. */
export const RUNTIME_POLICY_TIMEOUT_EXIT_CODE = 124;

/** Exit code this adapter reports when the worker's own event stream for a command becomes unusable (a non-2xx status the poll loop cannot recover from, or a response that fails schema validation). */
export const RUNTIME_PROTOCOL_ERROR_EXIT_CODE = 125;

function runtimePath(runtimeId: string, subpath = ""): string {
  return `/internal/runtime/v1/runtimes/${encodeURIComponent(runtimeId)}${subpath}`;
}

function parseWorkerResponse<T>(schema: ZodType<T>, raw: unknown, context: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new RemoteRuntimeProtocolError(
      `Runtime worker's ${context} response did not match the expected shape: ${result.error.message}`,
    );
  }
  return result.data;
}

function byteLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function validatePreviewUrl(config: RemoteRuntimeConfig, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RemoteRuntimePreviewRejectedError(`Runtime worker returned an unparseable preview URL: ${url}`);
  }

  const isHttps = parsed.protocol === "https:";
  const isAllowedLoopbackHttp =
    parsed.protocol === "http:" &&
    config.allowInsecureLoopback &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1");

  if (!isHttps && !isAllowedLoopbackHttp) {
    throw new RemoteRuntimePreviewRejectedError(
      `Runtime worker returned a preview URL with a disallowed scheme: ${url}`,
    );
  }

  if (config.previewBaseUrl && parsed.origin !== new URL(config.previewBaseUrl).origin) {
    throw new RemoteRuntimePreviewRejectedError(
      `Runtime worker returned a preview URL whose origin (${parsed.origin}) does not match the configured previewBaseUrl`,
    );
  }
}

/** Polls the worker's per-command event stream and fans output/exit events out to listeners registered via {@link RemoteRuntimeProcess.onOutput}/{@link RemoteRuntimeProcess.onExit}. */
class RemoteRuntimeProcess implements RuntimeProcess {
  readonly id: string;
  private readonly outputListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<(code: number) => void>();
  private stopped = false;
  private exited = false;
  private exitCode: number | undefined;
  private cancelRequested = false;
  private outputBytesSoFar = 0;
  private truncated = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private pollAbortController: AbortController | undefined;
  private readonly startedAt: number;
  private afterSeq = 0;

  constructor(
    private readonly config: RemoteRuntimeConfig,
    private readonly runtimeId: string,
    commandId: string,
    private readonly httpOptions: HttpClientOptions,
  ) {
    this.id = commandId;
    this.startedAt = Date.now();
    this.schedulePoll(0);
  }

  onOutput(cb: (chunk: string) => void): void {
    this.outputListeners.add(cb);
  }

  onExit(cb: (code: number) => void): void {
    if (this.exited) {
      const code = this.exitCode!;
      queueMicrotask(() => cb(code));
      return;
    }
    this.exitListeners.add(cb);
  }

  async kill(): Promise<void> {
    this.stop();
    if (this.exited || this.cancelRequested) {
      return;
    }
    this.cancelRequested = true;
    try {
      await requestRuntimeWorker(
        this.config,
        runtimePath(this.runtimeId, `/commands/${encodeURIComponent(this.id)}/cancel`),
        { method: "POST" },
        this.httpOptions,
      );
    } catch {
      // Best-effort: the process is already stopped locally regardless of
      // whether the worker's own cancel takes effect.
    }
  }

  /** Settles this process as exited using a status the worker already reported, without polling for its own events. */
  settleExited(code: number): void {
    this.finish(code);
  }

  private stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.pollAbortController?.abort();
  }

  private schedulePoll(delayMs: number): void {
    this.pollTimer = setTimeout(() => {
      void this.poll();
    }, delayMs);
  }

  private emitOutput(chunk: string): void {
    if (this.truncated) {
      return;
    }

    this.outputBytesSoFar += byteLength(chunk);
    if (this.outputBytesSoFar > this.config.limits.maxCommandOutputBytes) {
      this.truncated = true;
      for (const listener of this.outputListeners) {
        listener(`\n[runtime-remote] command output truncated after exceeding the configured output limit\n`);
      }
      void this.kill();
      this.finish(RUNTIME_POLICY_TIMEOUT_EXIT_CODE);
      return;
    }

    for (const listener of this.outputListeners) {
      listener(chunk);
    }
  }

  private finish(code: number): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.exitCode = code;
    this.stop();
    for (const listener of this.exitListeners) {
      listener(code);
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (Date.now() - this.startedAt > this.config.commandTimeoutMs) {
      void this.kill();
      this.finish(RUNTIME_POLICY_TIMEOUT_EXIT_CODE);
      return;
    }

    this.pollAbortController = new AbortController();
    let raw: unknown;
    try {
      raw = await requestRuntimeWorker(
        this.config,
        runtimePath(this.runtimeId, `/commands/${encodeURIComponent(this.id)}/events?afterSeq=${this.afterSeq}`),
        { method: "GET", signal: this.pollAbortController.signal },
        this.httpOptions,
      );
    } catch {
      if (this.stopped) {
        return;
      }
      // A transient poll failure should not silently hang the process; the
      // caller learns about it through the next poll succeeding or, if the
      // command outlives its timeout, through the policy timeout above.
      this.schedulePoll(this.config.pollIntervalMs);
      return;
    }

    if (this.stopped) {
      return;
    }

    let parsed: { events: CommandEvent[]; nextSeq: number };
    try {
      parsed = parseWorkerResponse(commandEventsResponseSchema, raw, "command events");
    } catch {
      // The worker's event stream is unusable (e.g. it no longer matches
      // this adapter's schema); retrying would not help, so this command
      // is force-stopped rather than left to hang until commandTimeoutMs.
      void this.kill();
      this.finish(RUNTIME_PROTOCOL_ERROR_EXIT_CODE);
      return;
    }
    this.afterSeq = parsed.nextSeq;

    for (const event of parsed.events as CommandEvent[]) {
      if (event.type === "output") {
        this.emitOutput(event.chunk);
      } else {
        this.finish(event.code);
      }
      if (this.stopped) {
        return;
      }
    }

    if (!this.exited) {
      this.schedulePoll(this.config.pollIntervalMs);
    }
  }
}

/** Polls the worker's runtime-wide event stream (file and port changes) and fans events out to watchFiles/watchPorts subscribers, sharing one poll loop between both. */
class RemoteRuntimeEventBus {
  private readonly fileListeners = new Set<(event: { path: string; type: string }) => void>();
  private readonly portListeners = new Set<
    (event: { port: number; url: string; status: "open" | "close" }) => void
  >();
  private afterSeq = 0;
  private polling = false;
  /** Bumped every time polling stops; a poll captures its generation when scheduled and abandons itself if the generation has since moved on, so a stale in-flight poll from before an unsubscribe/resubscribe race can never resume or dispatch. */
  private generation = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private pollAbortController: AbortController | undefined;

  constructor(
    private readonly config: RemoteRuntimeConfig,
    private readonly getRuntimeId: () => Promise<string>,
    private readonly httpOptions: HttpClientOptions,
  ) {}

  addFileListener(cb: (event: { path: string; type: string }) => void): () => void {
    this.fileListeners.add(cb);
    this.ensurePolling();
    return () => {
      this.fileListeners.delete(cb);
      this.maybeStopPolling();
    };
  }

  addPortListener(cb: (event: { port: number; url: string; status: "open" | "close" }) => void): () => void {
    this.portListeners.add(cb);
    this.ensurePolling();
    return () => {
      this.portListeners.delete(cb);
      this.maybeStopPolling();
    };
  }

  stop(): void {
    this.polling = false;
    this.generation += 1;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.pollAbortController?.abort();
  }

  private maybeStopPolling(): void {
    if (this.fileListeners.size === 0 && this.portListeners.size === 0) {
      this.stop();
    }
  }

  private ensurePolling(): void {
    if (this.polling) {
      return;
    }
    this.polling = true;
    this.schedulePoll(0);
  }

  private schedulePoll(delayMs: number): void {
    const generation = this.generation;
    this.pollTimer = setTimeout(() => {
      void this.poll(generation);
    }, delayMs);
  }

  private dispatch(event: RuntimeEvent): void {
    if (event.type === "file.changed") {
      for (const listener of this.fileListeners) {
        listener({ path: event.path, type: event.changeType });
      }
    } else {
      // The worker is untrusted for preview URLs the same as for openPreview's
      // own response: an event carrying a disallowed scheme or origin must
      // never reach a subscriber.
      validatePreviewUrl(this.config, event.url);
      for (const listener of this.portListeners) {
        listener({ port: event.port, url: event.url, status: event.status });
      }
    }
  }

  private isCurrent(generation: number): boolean {
    return this.polling && generation === this.generation;
  }

  private async poll(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) {
      return;
    }

    let runtimeId: string;
    try {
      runtimeId = await this.getRuntimeId();
    } catch {
      if (this.isCurrent(generation)) {
        this.schedulePoll(this.config.pollIntervalMs);
      }
      return;
    }

    if (!this.isCurrent(generation)) {
      return;
    }

    this.pollAbortController = new AbortController();
    let raw: unknown;
    try {
      raw = await requestRuntimeWorker(
        this.config,
        runtimePath(runtimeId, `/events?afterSeq=${this.afterSeq}`),
        { method: "GET", signal: this.pollAbortController.signal },
        this.httpOptions,
      );
    } catch {
      if (this.isCurrent(generation)) {
        this.schedulePoll(this.config.pollIntervalMs);
      }
      return;
    }

    if (!this.isCurrent(generation)) {
      return;
    }

    let parsed: { events: RuntimeEvent[]; nextSeq: number };
    try {
      parsed = parseWorkerResponse(runtimeEventsResponseSchema, raw, "runtime events");
    } catch {
      // The worker's event stream is unusable; retrying would only repeat
      // the same failure, so the shared poll loop stops rather than spinning.
      this.stop();
      return;
    }
    this.afterSeq = parsed.nextSeq;
    try {
      for (const event of parsed.events) {
        this.dispatch(event);
        if (!this.isCurrent(generation)) {
          return;
        }
      }
    } catch {
      // A dispatched event failed this adapter's own validation (e.g. a
      // disallowed preview URL); the worker cannot be trusted further.
      this.stop();
      return;
    }

    if (this.isCurrent(generation)) {
      this.schedulePoll(this.config.pollIntervalMs);
    }
  }
}

/**
 * A production RuntimeAdapter backed by an HTTP sandbox worker. Runs no
 * commands and touches no files in this process: every operation is a
 * request to `config.baseUrl`, which must be a worker this deployment
 * trusts (see the package README for the worker's contract and this
 * adapter's security responsibilities).
 */
export function createRemoteRuntimeAdapter(
  configInput: RemoteRuntimeConfigInput,
  seedFiles: RemoteRuntimeSeedFile[] = [],
  httpOptions: HttpClientOptions = {},
): RuntimeAdapter {
  const config = validateRemoteRuntimeConfig(configInput);
  let runtimeId: string | undefined;
  let creatingRuntime: Promise<string> | undefined;
  let disposed = false;
  const liveProcesses = new Set<RemoteRuntimeProcess>();
  const eventBus = new RemoteRuntimeEventBus(config, ensureRuntime, httpOptions);

  function assertNotDisposed(): void {
    if (disposed) {
      throw new RemoteRuntimeError("This remote runtime has been disposed and cannot be used again");
    }
  }

  async function ensureRuntime(): Promise<string> {
    assertNotDisposed();
    if (runtimeId) {
      return runtimeId;
    }
    if (!creatingRuntime) {
      creatingRuntime = (async () => {
        if (seedFiles.length > config.limits.maxFileCount) {
          throw new RemoteRuntimeValidationError(
            `seed contains ${seedFiles.length} files, exceeding the configured limit of ${config.limits.maxFileCount}`,
          );
        }
        const totalSeedBytes = seedFiles.reduce((sum, file) => sum + byteLength(file.content), 0);
        if (totalSeedBytes > config.limits.maxSeedBytes) {
          throw new RemoteRuntimeValidationError(
            `seed totals ${totalSeedBytes} bytes, exceeding the configured limit of ${config.limits.maxSeedBytes}`,
          );
        }

        const raw = await requestRuntimeWorker(
          config,
          "/internal/runtime/v1/runtimes",
          {
            method: "POST",
            body: {
              sessionId: config.sessionId,
              projectId: config.projectId,
              image: config.image,
              profile: config.profile,
              limits: {
                maxFileBytes: config.limits.maxFileBytes,
                maxFileCount: config.limits.maxFileCount,
                maxCommandOutputBytes: config.limits.maxCommandOutputBytes,
              },
              network: { egressDeny: config.networkEgressDeny },
              seed: { files: seedFiles },
            },
          },
          httpOptions,
        );
        const parsed = parseWorkerResponse(runtimeCreateResponseSchema, raw, "runtime create");
        if (parsed.sessionId !== config.sessionId) {
          throw new RemoteRuntimeSessionMismatchError(
            `Runtime worker created a runtime for sessionId ${parsed.sessionId}, expected ${config.sessionId}`,
          );
        }
        runtimeId = parsed.runtimeId;
        return runtimeId;
      })().catch((error) => {
        creatingRuntime = undefined;
        throw error;
      });
    }
    return creatingRuntime;
  }

  return {
    async readFile(path) {
      const validPath = validateWorkspacePath(path);
      const id = await ensureRuntime();
      const raw = await requestRuntimeWorker(
        config,
        runtimePath(id, `/files?path=${encodeURIComponent(validPath)}`),
        { method: "GET" },
        httpOptions,
      );
      return parseWorkerResponse(fileReadResponseSchema, raw, "file read").content;
    },

    async writeFile(path, content) {
      const validPath = validateWorkspacePath(path);
      if (byteLength(content) > config.limits.maxFileBytes) {
        throw new RemoteRuntimeValidationError(
          `file content exceeds the configured limit of ${config.limits.maxFileBytes} bytes`,
        );
      }
      const id = await ensureRuntime();
      await requestRuntimeWorker(
        config,
        runtimePath(id, "/files"),
        { method: "PUT", body: { path: validPath, content } },
        httpOptions,
      );
    },

    async patchFile(path, patch) {
      const validPath = validateWorkspacePath(path);
      const id = await ensureRuntime();
      await requestRuntimeWorker(
        config,
        runtimePath(id, "/files"),
        { method: "PATCH", body: { path: validPath, patch } },
        httpOptions,
      );
    },

    async listFiles(root) {
      const validRoot = validateWorkspacePath(root, { allowEmpty: true });
      const id = await ensureRuntime();
      const raw = await requestRuntimeWorker(
        config,
        runtimePath(id, `/files/list?root=${encodeURIComponent(validRoot)}`),
        { method: "GET" },
        httpOptions,
      );
      return parseWorkerResponse(fileListResponseSchema, raw, "file list").files;
    },

    async snapshotFiles() {
      const id = await ensureRuntime();
      const raw = await requestRuntimeWorker(
        config,
        runtimePath(id, "/files/snapshot"),
        { method: "GET" },
        httpOptions,
      );
      const parsed = parseWorkerResponse(fileSnapshotResponseSchema, raw, "file snapshot");

      if (parsed.files.length > config.limits.maxFileCount) {
        throw new RemoteRuntimeValidationError(
          `snapshot contains ${parsed.files.length} files, exceeding the configured limit of ${config.limits.maxFileCount}`,
        );
      }
      let totalBytes = 0;
      for (const file of parsed.files) {
        totalBytes += byteLength(file.content);
        if (totalBytes > config.limits.maxSeedBytes) {
          throw new RemoteRuntimeValidationError(
            `snapshot totals more than the configured limit of ${config.limits.maxSeedBytes} bytes`,
          );
        }
      }

      return parsed.files;
    },

    async deleteFile(path) {
      const validPath = validateWorkspacePath(path);
      const id = await ensureRuntime();
      await requestRuntimeWorker(
        config,
        runtimePath(id, `/files?path=${encodeURIComponent(validPath)}`),
        { method: "DELETE" },
        httpOptions,
      );
    },

    async runCommand(command, opts) {
      const argv = tokenizeCommand(command, {
        maxCommandLength: config.limits.maxCommandLength,
        maxArgvCount: config.limits.maxArgvCount,
      });
      const cwd = opts?.cwd === undefined ? undefined : validateWorkspacePath(opts.cwd, { allowEmpty: true });
      const id = await ensureRuntime();
      const raw = await requestRuntimeWorker(
        config,
        runtimePath(id, "/commands"),
        {
          method: "POST",
          body: {
            argv,
            ...(cwd === undefined ? {} : { cwd }),
            timeoutMs: config.commandTimeoutMs,
            maxOutputBytes: config.limits.maxCommandOutputBytes,
            policy: { networkEgressDeny: config.networkEgressDeny },
          },
        },
        httpOptions,
      );
      const parsed = parseWorkerResponse(commandCreateResponseSchema, raw, "command create");
      const process = new RemoteRuntimeProcess(config, id, parsed.commandId, httpOptions);
      liveProcesses.add(process);
      process.onExit(() => {
        liveProcesses.delete(process);
      });
      if (parsed.status === "exited") {
        // The worker settled the command before we started polling for
        // events; settle here rather than letting the process silently poll
        // for events that already happened.
        if (parsed.exitCode !== undefined) {
          process.settleExited(parsed.exitCode);
        } else {
          const statusRaw = await requestRuntimeWorker(
            config,
            runtimePath(id, `/commands/${encodeURIComponent(parsed.commandId)}`),
            { method: "GET" },
            httpOptions,
          );
          const status = parseWorkerResponse(commandStatusResponseSchema, statusRaw, "command status");
          process.settleExited(status.exitCode ?? RUNTIME_PROTOCOL_ERROR_EXIT_CODE);
        }
      }
      return process;
    },

    async openPreview(port) {
      const id = await ensureRuntime();
      const raw = await requestRuntimeWorker(
        config,
        runtimePath(id, "/previews"),
        { method: "POST", body: port === undefined ? {} : { port } },
        httpOptions,
      );
      const parsed = parseWorkerResponse(previewResponseSchema, raw, "preview");
      validatePreviewUrl(config, parsed.url);
      return parsed satisfies RuntimePort;
    },

    async watchFiles(cb) {
      await ensureRuntime();
      return eventBus.addFileListener(cb);
    },

    async watchPorts(cb) {
      await ensureRuntime();
      return eventBus.addPortListener(cb);
    },

    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      eventBus.stop();
      for (const process of liveProcesses) {
        try {
          await process.kill();
        } catch {
          // Best-effort: proceed to delete the runtime regardless.
        }
      }
      liveProcesses.clear();

      let idToDelete = runtimeId;
      if (!idToDelete && creatingRuntime) {
        try {
          idToDelete = await creatingRuntime;
        } catch {
          // The runtime was never actually created on the worker; nothing to delete.
          idToDelete = undefined;
        }
      }
      if (idToDelete) {
        await requestRuntimeWorker(config, runtimePath(idToDelete), { method: "DELETE" }, httpOptions);
      }
    },
  };
}
