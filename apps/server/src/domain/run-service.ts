import { resolveModelGateway, type ModelGateway } from "@ezu/model-gateway";
import { type AgentEvent } from "@ezu/protocol";

import {
  chargeUsage,
  isBillingEnabled,
  refundUsageCharge,
  MissingIdempotencyKeyError,
} from "./billing/billing-service.js";
import {
  createMemoryRunRepository,
  RunNotFoundError,
  type RunRecord,
  type RunRepository,
  type RunStatus,
} from "./run-repository.js";
import { appendSessionEvents, getSession } from "./sessions.js";

export { RunNotFoundError };

let runRepository: RunRepository = createMemoryRunRepository();

export function configureRunRepository(repository: RunRepository): void {
  runRepository = repository;
}

let modelGatewayFactory: () => ModelGateway = () => resolveModelGateway(process.env);

/** Test seam: inject a fake gateway instead of resolving one from the environment. */
export function configureModelGatewayFactory(factory: () => ModelGateway): void {
  modelGatewayFactory = factory;
}

export interface RunDto {
  id: string;
  sessionId: string;
  status: RunStatus;
  lastEventSeq: number;
  error?: string;
}

// Tracks the in-flight abort controller for each executing run so a cancel
// request can interrupt the underlying model request. Entries are removed
// once the run reaches a terminal state.
const abortControllers = new Map<string, AbortController>();

// Executions started by this process, so a duplicate createRun call for the
// same deterministic run id does not start a second background execution.
const executing = new Set<string>();

function toRunDto(run: RunRecord, lastEventSeq: number): RunDto {
  return {
    id: run.id,
    sessionId: run.sessionId,
    status: run.status,
    lastEventSeq,
    ...(run.error ? { error: run.error } : {}),
  };
}

async function lastEventSeqFor(runId: string): Promise<number> {
  const events = await runRepository.listEventsAfter(runId, 0);
  return events.at(-1)?.seq ?? 0;
}

function deterministicRunId(sessionId: string, requestId: string | undefined): string {
  // A requestId-scoped id makes retried POST /runs idempotent: replaying the
  // same requestId resolves to the same run instead of starting a second one.
  return requestId ? `run:${sessionId}:${requestId}` : crypto.randomUUID();
}

export interface CreateRunInput {
  kind: "prompt";
  text: string;
  requestId?: string;
}

export async function createRun(
  sessionId: string,
  input: CreateRunInput,
  requestingUserId?: string,
): Promise<RunDto> {
  // Ownership check: throws SessionNotFoundError (404) if the session is
  // missing or owned by someone else, before any billing or run creation.
  await getSession(sessionId, requestingUserId);

  const shouldCharge = isBillingEnabled() && Boolean(requestingUserId);
  if (shouldCharge && !input.requestId) {
    throw new MissingIdempotencyKeyError("A requestId is required to charge usage");
  }

  const runId = deterministicRunId(sessionId, input.requestId);

  if (input.requestId) {
    // Independent of billing: a replayed requestId must never attempt to
    // create the same deterministic run id twice.
    const existing = await runRepository.get(runId);
    if (existing) {
      return toRunDto(existing, await lastEventSeqFor(runId));
    }
  }

  if (shouldCharge) {
    const charge = await chargeUsage({
      userId: requestingUserId!,
      kind: "prompt",
      sessionId,
      requestId: input.requestId ?? "",
    });
    if (!charge.applied) {
      const existing = await runRepository.get(runId);
      if (existing) {
        return toRunDto(existing, await lastEventSeqFor(runId));
      }
    }
  }

  const run = await runRepository.create({
    id: runId,
    sessionId,
    ...(requestingUserId ? { userId: requestingUserId } : {}),
    kind: input.kind,
    input: { text: input.text, requestId: input.requestId },
  });

  if (!executing.has(run.id)) {
    executing.add(run.id);
    void executeRun(run.id).finally(() => executing.delete(run.id));
  }

  return toRunDto(run, 0);
}

async function ensureRunVisible(
  sessionId: string,
  runId: string,
  requestingUserId?: string,
): Promise<RunRecord> {
  await getSession(sessionId, requestingUserId);
  const run = await runRepository.get(runId);
  if (!run || run.sessionId !== sessionId) {
    throw new RunNotFoundError(`Unknown run: ${runId}`);
  }
  if (run.userId && run.userId !== requestingUserId) {
    throw new RunNotFoundError(`Unknown run: ${runId}`);
  }
  return run;
}

export async function getRun(sessionId: string, runId: string, requestingUserId?: string): Promise<RunDto> {
  const run = await ensureRunVisible(sessionId, runId, requestingUserId);
  return toRunDto(run, await lastEventSeqFor(runId));
}

export interface RunEventDto {
  seq: number;
  event: AgentEvent;
}

export async function listRunEvents(
  sessionId: string,
  runId: string,
  afterSeq: number,
  requestingUserId?: string,
): Promise<RunEventDto[]> {
  await ensureRunVisible(sessionId, runId, requestingUserId);
  return runRepository.listEventsAfter(runId, afterSeq);
}

export async function cancelRun(
  sessionId: string,
  runId: string,
  requestingUserId?: string,
): Promise<RunDto> {
  await ensureRunVisible(sessionId, runId, requestingUserId);
  // Persist the cancellation request before touching the abort controller so
  // a crash between the two steps still leaves the run flagged for recovery.
  const updated = await runRepository.requestCancel(runId);
  abortControllers.get(runId)?.abort(new Error("Run cancelled by user"));
  return toRunDto(updated, await lastEventSeqFor(runId));
}

async function settleRun(run: RunRecord, terminalError: unknown): Promise<void> {
  const shouldRefund =
    isBillingEnabled() &&
    Boolean(run.userId) &&
    typeof (run.input as { requestId?: string } | undefined)?.requestId === "string";
  const requestId = (run.input as { requestId?: string }).requestId ?? "";

  const current = await runRepository.get(run.id);
  const cancelRequested = current?.cancelRequested ?? run.cancelRequested;
  const expectedVersion = current?.version ?? run.version;

  if (cancelRequested) {
    await runRepository.cancel(run.id, expectedVersion);
  } else if (terminalError) {
    const message = terminalError instanceof Error ? terminalError.message : String(terminalError);
    await runRepository.fail(run.id, expectedVersion, message);
  } else {
    await runRepository.complete(run.id, expectedVersion);
  }

  if (shouldRefund && (cancelRequested || terminalError)) {
    await refundUsageCharge({
      userId: run.userId!,
      kind: "prompt",
      sessionId: run.sessionId,
      requestId,
      reason: cancelRequested ? "run cancelled" : "run failed",
    }).catch(() => undefined);
  }
}

async function executeRun(runId: string): Promise<void> {
  const created = await runRepository.get(runId);
  if (!created) return;

  const claimed = await runRepository.claim(runId).catch(() => undefined);
  if (!claimed) return;

  const controller = new AbortController();
  abortControllers.set(runId, controller);

  const emittedEvents: AgentEvent[] = [];
  let terminalError: unknown;

  try {
    const text = (claimed.input as { text: string }).text;
    const userMessageId = crypto.randomUUID();
    const userEvents: AgentEvent[] = [
      { type: "message.delta", messageId: userMessageId, text, role: "user" },
      { type: "message.completed", messageId: userMessageId },
    ];
    for (const event of userEvents) {
      await runRepository.appendEvent(runId, event);
      emittedEvents.push(event);
    }

    const gateway = modelGatewayFactory();
    for await (const event of gateway.streamPlan({ prompt: text, signal: controller.signal })) {
      const current = await runRepository.get(runId);
      if (current?.cancelRequested) {
        controller.abort(new Error("Run cancelled by user"));
        break;
      }
      await runRepository.appendEvent(runId, event);
      emittedEvents.push(event);
    }
  } catch (error) {
    terminalError = error;
  } finally {
    abortControllers.delete(runId);
  }

  await appendSessionEvents(claimed.sessionId, emittedEvents, claimed.userId).catch(() => undefined);
  await settleRun(claimed, terminalError);
}

/**
 * Startup recovery: a run left "running" when the process last stopped
 * cannot be resumed (its AbortController and any in-flight fetch are gone),
 * so it is marked failed. A run left "queued" is safe to re-run from
 * scratch since it never produced any side effects.
 */
export async function recoverRunsOnStartup(): Promise<void> {
  const running = await runRepository.listRunningRuns();
  for (const run of running) {
    await runRepository
      .fail(run.id, run.version, "Interrupted by server restart")
      .catch(() => undefined);
  }

  const queued = await runRepository.listQueuedRuns();
  for (const run of queued) {
    if (!executing.has(run.id)) {
      executing.add(run.id);
      void executeRun(run.id).finally(() => executing.delete(run.id));
    }
  }
}
