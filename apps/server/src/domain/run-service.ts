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
  RunAlreadyExistsError,
  RunNotFoundError,
  RunVersionConflictError,
  type RunRecord,
  type RunRepository,
  type RunStatus,
} from "./run-repository.js";
import { appendSessionEvents, getSession } from "./sessions.js";

export { RunNotFoundError };

const RUN_TERMINAL_STATUSES = new Set<RunStatus>(["completed", "failed", "cancelled"]);

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
  return runRepository.getLastEventSeq(runId);
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

  let run: RunRecord;
  try {
    run = await runRepository.create({
      id: runId,
      sessionId,
      ...(requestingUserId ? { userId: requestingUserId } : {}),
      kind: input.kind,
      input: { text: input.text, requestId: input.requestId },
    });
  } catch (error) {
    // A concurrent createRun call for the same requestId can win the create
    // race; chargeUsage above already deduped the charge by requestId, so
    // the loser just replays the winner's run instead of erroring out.
    if (error instanceof RunAlreadyExistsError) {
      const existing = await runRepository.get(runId);
      if (existing) {
        return toRunDto(existing, await lastEventSeqFor(runId));
      }
    }
    throw error;
  }

  if (!executing.has(run.id)) {
    executing.add(run.id);
    void executeRun(run.id).catch(() => undefined).finally(() => executing.delete(run.id));
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

export interface RunStreamPoll {
  events: RunEventDto[];
  status: RunStatus;
  lastEventSeq: number;
}

/**
 * Polls a run's new events and terminal status directly, without repeating
 * the session/run ownership check. The caller must have already established
 * visibility once (e.g. via getRun) before it starts polling; ownership
 * cannot change over a run's lifetime, so re-checking it on every poll would
 * only add repeated session reads for no safety benefit.
 */
export async function pollRunStream(runId: string, afterSeq: number): Promise<RunStreamPoll> {
  const events = await runRepository.listEventsAfter(runId, afterSeq);
  const run = await runRepository.get(runId);
  if (!run) {
    throw new RunNotFoundError(`Unknown run: ${runId}`);
  }
  const lastEventSeq = await runRepository.getLastEventSeq(runId);
  return { events, status: run.status, lastEventSeq };
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

// A requestCancel can land between reading a run's current version and
// writing its terminal transition (both readable through the public
// RunRepository interface, so this is a real race, not a hypothetical one).
// Retrying with a fresh read bounds that race instead of ever surfacing a
// RunVersionConflictError up through the background execution promise.
const MAX_SETTLE_ATTEMPTS = 5;

async function settleRun(run: RunRecord, terminalError: unknown): Promise<void> {
  const shouldRefund =
    isBillingEnabled() &&
    Boolean(run.userId) &&
    typeof (run.input as { requestId?: string } | undefined)?.requestId === "string";
  const requestId = (run.input as { requestId?: string }).requestId ?? "";

  let cancelRequested = run.cancelRequested;
  for (let attempt = 1; attempt <= MAX_SETTLE_ATTEMPTS; attempt++) {
    const current = await runRepository.get(run.id);
    if (!current) return;
    cancelRequested = current.cancelRequested;

    try {
      if (cancelRequested) {
        await runRepository.cancel(run.id, current.version);
      } else if (terminalError) {
        const message = terminalError instanceof Error ? terminalError.message : String(terminalError);
        await runRepository.fail(run.id, current.version, message);
      } else {
        await runRepository.complete(run.id, current.version);
      }
      break;
    } catch (error) {
      if (!(error instanceof RunVersionConflictError) || attempt === MAX_SETTLE_ATTEMPTS) {
        throw error;
      }
    }
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

/**
 * Best-effort fallback when settleRun itself fails (e.g. its bounded CAS
 * retry is exhausted): forces the run to failed with a fresh version and
 * still attempts the usage refund, so a run never gets stuck running/queued
 * and a charge is never left un-refunded because of a settlement error.
 */
async function forceFailAfterSettlementFailure(run: RunRecord): Promise<void> {
  const current = await runRepository.get(run.id).catch(() => undefined);
  if (current && !RUN_TERMINAL_STATUSES.has(current.status)) {
    await runRepository.fail(run.id, current.version, "Run settlement failed").catch(() => undefined);
  }
  if (isBillingEnabled() && run.userId) {
    const requestId = (run.input as { requestId?: string } | undefined)?.requestId ?? "";
    await refundUsageCharge({
      userId: run.userId,
      kind: "prompt",
      sessionId: run.sessionId,
      requestId,
      reason: "run settlement failed",
    }).catch(() => undefined);
  }
}

async function executeRun(runId: string): Promise<void> {
  let claimed: RunRecord | undefined;
  try {
    const created = await runRepository.get(runId);
    if (!created) return;

    claimed = await runRepository.claim(runId).catch(() => undefined);
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
  } catch (error) {
    // This background promise is started with `void`; nothing awaits it, so
    // any error must be handled here rather than becoming an unhandled
    // rejection.
    if (claimed) {
      await forceFailAfterSettlementFailure(claimed).catch(() => undefined);
    }
  }
}

/**
 * Fails a run interrupted mid-execution by a server restart and, if it was
 * charged, refunds the charge. refundUsageCharge is idempotent per
 * requestId, so re-running startup recovery after a fast restart-of-a-restart
 * never double-refunds.
 */
async function failInterruptedRun(run: RunRecord): Promise<void> {
  await runRepository.fail(run.id, run.version, "Interrupted by server restart");
  if (isBillingEnabled() && run.userId) {
    const requestId = (run.input as { requestId?: string } | undefined)?.requestId ?? "";
    await refundUsageCharge({
      userId: run.userId,
      kind: "prompt",
      sessionId: run.sessionId,
      requestId,
      reason: "run interrupted by restart",
    }).catch(() => undefined);
  }
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
    // One run's failure (fail() conflicting, refund erroring, etc.) must
    // never stop recovery from reaching the rest of the running/queued runs.
    await failInterruptedRun(run).catch(() => undefined);
  }

  const queued = await runRepository.listQueuedRuns();
  for (const run of queued) {
    if (!executing.has(run.id)) {
      executing.add(run.id);
      void executeRun(run.id).catch(() => undefined).finally(() => executing.delete(run.id));
    }
  }
}
