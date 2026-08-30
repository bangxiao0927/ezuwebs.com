import { randomUUID } from "node:crypto";

import type { CommandHandle, DockerEngine } from "../docker/engine.js";
import { checkCommandPolicy } from "./command-policy.js";

export class CommandValidationError extends Error {}
export class CommandNotFoundError extends Error {}

export interface CommandLimits {
  maxTimeoutMs: number;
  maxOutputBytes: number;
}

export type CommandEvent =
  | { seq: number; type: "output"; stream: "stdout" | "stderr"; chunk: string }
  | { seq: number; type: "exit"; code: number | undefined };

export interface CreateCommandInput {
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  policy: string;
}

export interface CommandStatus {
  status: "running" | "exited";
  exitCode?: number;
  timedOut: boolean;
  oomKilled: boolean;
  truncated: boolean;
  policyViolation: boolean;
}

interface CommandState {
  containerId: string;
  handle: CommandHandle;
  events: CommandEvent[];
  nextSeq: number;
  status: CommandStatus;
  outputBytesSoFar: number;
  maxOutputBytes: number;
}

function clampToPositiveFinite(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new CommandValidationError(`${name} must be a finite positive number`);
  }
  return Math.min(Math.floor(value), max);
}

/**
 * Runs argv commands through a `DockerEngine`, after re-checking them
 * against a named allowlist policy. Every command's output and terminal
 * state are recorded as a sequenced event log so a client can poll
 * `getEvents(commandId, afterSeq)` without losing output between polls.
 *
 * Timeout, explicit cancel, and hitting the output limit all end a command
 * the same conservative way: by terminating the whole container
 * (`DockerEngine.terminateContainer`), not by killing the `docker exec`
 * client. Killing only the client leaves the exec'd process running inside
 * the container. `onTerminated`, given per command at `create()` time, lets
 * the caller react (e.g. mark the owning runtime failed).
 */
export class CommandService {
  private readonly commands = new Map<string, CommandState>();

  constructor(
    private readonly engine: DockerEngine,
    private readonly limits: CommandLimits,
  ) {}

  create(
    containerId: string,
    input: CreateCommandInput,
    onTerminated?: () => void,
  ): { commandId: string; status: "running" | "exited" } {
    checkCommandPolicy(input.policy, input.argv);
    const timeoutMs = clampToPositiveFinite(input.timeoutMs, "timeoutMs", this.limits.maxTimeoutMs);
    const maxOutputBytes = clampToPositiveFinite(input.maxOutputBytes, "maxOutputBytes", this.limits.maxOutputBytes);

    const commandId = `cmd_${randomUUID()}`;
    const handle = this.engine.execCommand(containerId, input.argv, {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      timeoutMs,
      maxOutputBytes,
    });
    const state: CommandState = {
      containerId,
      handle,
      events: [],
      nextSeq: 0,
      outputBytesSoFar: 0,
      maxOutputBytes,
      status: {
        status: "running",
        timedOut: false,
        oomKilled: false,
        truncated: false,
        policyViolation: false,
      },
    };
    this.commands.set(commandId, state);

    handle.onOutput((stream, chunk) => {
      if (state.status.truncated) {
        return;
      }
      state.outputBytesSoFar += Buffer.byteLength(chunk, "utf8");
      if (state.outputBytesSoFar > state.maxOutputBytes) {
        state.status = { ...state.status, truncated: true };
        void state.handle.cancel();
        return;
      }
      state.events.push({ seq: state.nextSeq, type: "output", stream, chunk });
      state.nextSeq += 1;
    });
    handle.onExit((result) => {
      const mustTerminateContainer = result.timedOut || result.cancelled || state.status.truncated;
      state.status = {
        status: "exited",
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        timedOut: result.timedOut,
        oomKilled: result.oomKilled,
        truncated: state.status.truncated || result.truncated,
        policyViolation: false,
      };
      state.events.push({ seq: state.nextSeq, type: "exit", code: result.exitCode });
      state.nextSeq += 1;
      if (mustTerminateContainer) {
        void this.engine
          .terminateContainer(containerId)
          .catch(() => {})
          .then(() => onTerminated?.());
      }
    });

    return { commandId, status: state.status.status };
  }

  private stateFor(containerId: string, commandId: string): CommandState | undefined {
    const state = this.commands.get(commandId);
    if (!state || state.containerId !== containerId) {
      return undefined;
    }
    return state;
  }

  getStatus(containerId: string, commandId: string): CommandStatus | undefined {
    return this.stateFor(containerId, commandId)?.status;
  }

  getEvents(containerId: string, commandId: string, afterSeq: number): { events: CommandEvent[]; nextSeq: number } {
    const state = this.stateFor(containerId, commandId);
    if (!state) {
      throw new CommandNotFoundError(`Unknown command: ${commandId}`);
    }
    const events = state.events.filter((event) => event.seq >= afterSeq);
    return { events, nextSeq: state.nextSeq };
  }

  async cancel(containerId: string, commandId: string): Promise<void> {
    const state = this.stateFor(containerId, commandId);
    if (!state) {
      throw new CommandNotFoundError(`Unknown command: ${commandId}`);
    }
    await state.handle.cancel();
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.commands.values()].map((state) => state.handle.cancel()));
  }

  /** Cancels and forgets every command that was run against this container, e.g. once its runtime is gone. */
  async disposeForContainer(containerId: string): Promise<void> {
    const toRemove = [...this.commands.entries()].filter(([, state]) => state.containerId === containerId);
    await Promise.all(toRemove.map(([, state]) => state.handle.cancel()));
    for (const [commandId] of toRemove) {
      this.commands.delete(commandId);
    }
  }
}
