import test from "node:test";
import assert from "node:assert/strict";

import { type AgentEvent } from "@ezu/protocol";
import type { ModelGateway, PlannerInput } from "@ezu/model-gateway";

import { createMemoryBillingStore } from "./billing/memory-billing-store.js";
import {
  FREE_GRANT_CREDITS,
  USAGE_COSTS,
  chargeUsage,
  configureBillingStore,
  configureBillingEnabled,
  getBillingSummary,
} from "./billing/billing-service.js";
import { createMemorySessionRepository } from "./session-repository.js";
import { configureSessionRepository, createSession, getSession } from "./sessions.js";
import { createMemoryRunRepository } from "./run-repository.js";
import type { RunRepository } from "./run-repository.js";
import {
  cancelRun,
  configureModelGatewayFactory,
  configureRunRepository,
  createRun,
  getRun,
  listRunEvents,
  pollRunStream,
  recoverRunsOnStartup,
  RunNotFoundError,
} from "./run-service.js";

const USER_ID = "user-a";

function resetBilling(): void {
  configureBillingStore(createMemoryBillingStore());
}

function resetState(): void {
  resetBilling();
  configureBillingEnabled(true);
  configureSessionRepository(createMemorySessionRepository());
  configureRunRepository(createMemoryRunRepository());
}

function fakeGatewayEmitting(events: AgentEvent[], options: { hang?: boolean } = {}): ModelGateway {
  return {
    getProfile: () => ({
      planning: { model: "test", temperature: 0 },
      coding: { model: "test", temperature: 0 },
      review: { model: "test", temperature: 0 },
      summary: { model: "test", temperature: 0 },
      title: { model: "test", temperature: 0 },
    }),
    async *streamPlan(input: PlannerInput) {
      for (const event of events) {
        if (options.hang) {
          await new Promise((resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        yield event;
      }
    },
    async *streamCode() {},
    async summarizeProject() {
      return "";
    },
  };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}

test("createRun runs to completion and its events are replayable via listRunEvents", async () => {
  resetState();
  configureBillingEnabled(false);
  try {
    configureModelGatewayFactory(() =>
      fakeGatewayEmitting([{ type: "message.delta", messageId: "m1", text: "hi" }]),
    );

    const session = await createSession("club-promo");
    const run = await createRun(session.id, { kind: "prompt", text: "Do the thing" });

    await waitFor(async () => (await getRun(session.id, run.id)).status === "completed");

    const events = await listRunEvents(session.id, run.id, 0);
    assert.ok(events.some((entry) => entry.event.type === "message.delta"));
    assert.ok(events.some((entry) => entry.event.type === "message.completed"));

    const reloaded = await getSession(session.id);
    assert.ok(
      reloaded.viewModel.chatMessages.some(
        (message) => message.role === "user" && message.content === "Do the thing",
      ),
    );
  } finally {
    configureBillingEnabled(true);
  }
});

test("createRun charges credits, and completing the run does not refund the charge", async () => {
  resetState();
  configureModelGatewayFactory(() =>
    fakeGatewayEmitting([{ type: "message.delta", messageId: "m1", text: "hi" }]),
  );

  const session = await createSession("club-promo", USER_ID);
  const run = await createRun(session.id, { kind: "prompt", text: "hi", requestId: "req-1" }, USER_ID);
  await waitFor(async () => (await getRun(session.id, run.id, USER_ID)).status === "completed");

  const summary = await getBillingSummary(USER_ID);
  assert.equal(summary.balance, FREE_GRANT_CREDITS - USAGE_COSTS["prompt"]!);
});

test("createRun replaying the same requestId returns the same run instead of starting a second one", async () => {
  resetState();
  configureModelGatewayFactory(() =>
    fakeGatewayEmitting([{ type: "message.delta", messageId: "m1", text: "hi" }]),
  );

  const session = await createSession("club-promo", USER_ID);
  const first = await createRun(session.id, { kind: "prompt", text: "hi", requestId: "req-1" }, USER_ID);
  const replay = await createRun(session.id, { kind: "prompt", text: "hi", requestId: "req-1" }, USER_ID);

  assert.equal(replay.id, first.id);
  await waitFor(async () => (await getRun(session.id, first.id, USER_ID)).status === "completed");
  const summary = await getBillingSummary(USER_ID);
  assert.equal(summary.balance, FREE_GRANT_CREDITS - USAGE_COSTS["prompt"]!);
});

test("cancelRun stops the run, marks it cancelled, and refunds the charge", async () => {
  resetState();
  configureModelGatewayFactory(() =>
    fakeGatewayEmitting([{ type: "message.delta", messageId: "m1", text: "still going" }], { hang: true }),
  );

  const session = await createSession("club-promo", USER_ID);
  const run = await createRun(session.id, { kind: "prompt", text: "hi", requestId: "req-1" }, USER_ID);
  await waitFor(async () => (await getRun(session.id, run.id, USER_ID)).status === "running");

  await cancelRun(session.id, run.id, USER_ID);
  await waitFor(async () => (await getRun(session.id, run.id, USER_ID)).status === "cancelled");

  const summary = await getBillingSummary(USER_ID);
  assert.equal(summary.balance, FREE_GRANT_CREDITS);
});

test("pollRunStream returns new events and the run's terminal status without an ownership check", async () => {
  resetState();
  configureBillingEnabled(false);
  try {
    configureModelGatewayFactory(() =>
      fakeGatewayEmitting([{ type: "message.delta", messageId: "m1", text: "hi" }]),
    );

    const session = await createSession("club-promo");
    const run = await createRun(session.id, { kind: "prompt", text: "hi" });
    await waitFor(async () => (await getRun(session.id, run.id)).status === "completed");

    const poll = await pollRunStream(run.id, 0);
    assert.equal(poll.status, "completed");
    assert.equal(poll.lastEventSeq, poll.events.at(-1)?.seq);
    assert.ok(poll.events.some((entry) => entry.event.type === "message.delta"));

    await assert.rejects(pollRunStream("missing-run", 0), RunNotFoundError);
  } finally {
    configureBillingEnabled(true);
  }
});

test("createRun called concurrently with the same requestId never throws and only charges once", async () => {
  resetState();
  configureModelGatewayFactory(() =>
    fakeGatewayEmitting([{ type: "message.delta", messageId: "m1", text: "hi" }]),
  );

  const base = createMemoryRunRepository();
  let createCalls = 0;
  // Deterministically forces the race: the first createRun's own
  // runRepository.create() call is the one delayed, so the second
  // createRun's create() call for the same run id wins and the first must
  // observe RunAlreadyExistsError from the repository.
  const racy: RunRepository = {
    ...base,
    async create(input) {
      createCalls += 1;
      if (createCalls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return base.create(input);
    },
  };
  configureRunRepository(racy);

  const session = await createSession("club-promo", USER_ID);
  const [first, second] = await Promise.all([
    createRun(session.id, { kind: "prompt", text: "hi", requestId: "req-concurrent" }, USER_ID),
    createRun(session.id, { kind: "prompt", text: "hi", requestId: "req-concurrent" }, USER_ID),
  ]);

  assert.equal(first.id, second.id);
  assert.equal(createCalls, 2, "both createRun calls must have reached runRepository.create");
  await waitFor(async () => (await getRun(session.id, first.id, USER_ID)).status === "completed");
  const summary = await getBillingSummary(USER_ID);
  assert.equal(summary.balance, FREE_GRANT_CREDITS - USAGE_COSTS["prompt"]!);
});

test("getRun and listRunEvents hide a run whose owner does not match the requester, on an unowned session", async () => {
  resetState();
  configureBillingEnabled(false);
  try {
    configureModelGatewayFactory(() => fakeGatewayEmitting([]));

    const session = await createSession("club-promo");
    const run = await createRun(session.id, { kind: "prompt", text: "hi" }, USER_ID);

    await waitFor(async () => (await getRun(session.id, run.id, USER_ID)).status === "completed");
    await assert.rejects(getRun(session.id, run.id, "someone-else"), RunNotFoundError);
    await assert.rejects(listRunEvents(session.id, run.id, 0, "someone-else"), RunNotFoundError);
  } finally {
    configureBillingEnabled(true);
  }
});

test("recoverRunsOnStartup fails a run left running, without double-executing it", async () => {
  resetState();
  configureBillingEnabled(false);
  try {
    const repository = createMemoryRunRepository();
    configureRunRepository(repository);
    configureModelGatewayFactory(() => fakeGatewayEmitting([]));

    const session = await createSession("club-promo");
    const created = await repository.create({
      id: "run-orphan",
      sessionId: session.id,
      kind: "prompt",
      input: { text: "hi" },
    });
    await repository.claim(created.id);

    await recoverRunsOnStartup();

    const recovered = await getRun(session.id, "run-orphan");
    assert.equal(recovered.status, "failed");
  } finally {
    configureBillingEnabled(true);
  }
});

test("recoverRunsOnStartup refunds a charged run left running, idempotently across two calls", async () => {
  resetState();
  configureModelGatewayFactory(() => fakeGatewayEmitting([]));

  const repository = createMemoryRunRepository();
  configureRunRepository(repository);

  const session = await createSession("club-promo", USER_ID);
  await chargeUsage({ userId: USER_ID, kind: "prompt", sessionId: session.id, requestId: "req-orphan" });
  const created = await repository.create({
    id: "run-orphan",
    sessionId: session.id,
    userId: USER_ID,
    kind: "prompt",
    input: { text: "hi", requestId: "req-orphan" },
  });
  await repository.claim(created.id);

  await recoverRunsOnStartup();
  const recovered = await getRun(session.id, "run-orphan", USER_ID);
  assert.equal(recovered.status, "failed");
  assert.equal((await getBillingSummary(USER_ID)).balance, FREE_GRANT_CREDITS);

  // A second recovery pass (e.g. a fast restart-of-a-restart) must not
  // double-refund an already-refunded charge.
  await recoverRunsOnStartup();
  assert.equal((await getBillingSummary(USER_ID)).balance, FREE_GRANT_CREDITS);
});

test("recoverRunsOnStartup isolates one run's failure from the rest", async () => {
  resetState();
  configureBillingEnabled(false);
  try {
    configureModelGatewayFactory(() => fakeGatewayEmitting([]));
    const base = createMemoryRunRepository();
    const flaky: RunRepository = {
      ...base,
      async fail(id, expectedVersion, error) {
        if (id === "run-bad") throw new Error("boom");
        return base.fail(id, expectedVersion, error);
      },
    };
    configureRunRepository(flaky);

    const session = await createSession("club-promo");
    const bad = await base.create({ id: "run-bad", sessionId: session.id, kind: "prompt", input: {} });
    await base.claim(bad.id);
    const good = await base.create({ id: "run-good", sessionId: session.id, kind: "prompt", input: {} });
    await base.claim(good.id);

    await recoverRunsOnStartup();

    assert.equal((await getRun(session.id, "run-good")).status, "failed");
  } finally {
    configureBillingEnabled(true);
  }
});

test("settling a completed run that raced with a concurrent cancel still ends up cancelled, with a refund", async () => {
  resetState();
  configureModelGatewayFactory(() =>
    fakeGatewayEmitting([{ type: "message.delta", messageId: "m1", text: "hi" }]),
  );

  const base = createMemoryRunRepository();
  // Simulates a requestCancel landing between settleRun's fresh read and its
  // first CAS write attempt: the injected cancel bumps the run's version out
  // from under the in-flight complete() call, so it must conflict once.
  let injectedCancel = false;
  const racy: RunRepository = {
    ...base,
    async complete(id, expectedVersion) {
      if (!injectedCancel) {
        injectedCancel = true;
        await base.requestCancel(id);
      }
      return base.complete(id, expectedVersion);
    },
  };
  configureRunRepository(racy);

  const session = await createSession("club-promo", USER_ID);
  const run = await createRun(session.id, { kind: "prompt", text: "hi", requestId: "req-1" }, USER_ID);

  await waitFor(async () => (await getRun(session.id, run.id, USER_ID)).status === "cancelled");
  assert.ok(injectedCancel, "the race must have actually been exercised");

  const summary = await getBillingSummary(USER_ID);
  assert.equal(summary.balance, FREE_GRANT_CREDITS);
});

test("executeRun never rejects unhandled: a settlement that keeps conflicting still ends the run and refunds", async () => {
  resetState();
  configureModelGatewayFactory(() =>
    fakeGatewayEmitting([{ type: "message.delta", messageId: "m1", text: "hi" }]),
  );

  const base = createMemoryRunRepository();
  // Simulates settleRun exhausting its bounded retry budget: every attempt
  // to reach a terminal state conflicts, so the caller must fall back to a
  // best-effort failure instead of leaving the promise (and the run) hanging.
  const alwaysConflicting: RunRepository = {
    ...base,
    async complete() {
      const { RunVersionConflictError } = await import("./run-repository.js");
      throw new RunVersionConflictError("always conflicts");
    },
  };
  configureRunRepository(alwaysConflicting);

  const session = await createSession("club-promo", USER_ID);
  const run = await createRun(session.id, { kind: "prompt", text: "hi", requestId: "req-1" }, USER_ID);

  await waitFor(async () => {
    const status = (await getRun(session.id, run.id, USER_ID)).status;
    return status === "failed" || status === "cancelled" || status === "completed";
  });

  const summary = await getBillingSummary(USER_ID);
  assert.equal(summary.balance, FREE_GRANT_CREDITS);
});
