import test from "node:test";
import assert from "node:assert/strict";

import { type AgentEvent } from "@ezu/protocol";
import type { ModelGateway, PlannerInput } from "@ezu/model-gateway";

import { createMemoryBillingStore } from "./billing/memory-billing-store.js";
import {
  FREE_GRANT_CREDITS,
  USAGE_COSTS,
  configureBillingStore,
  configureBillingEnabled,
  getBillingSummary,
} from "./billing/billing-service.js";
import { createMemorySessionRepository } from "./session-repository.js";
import { configureSessionRepository, createSession, getSession } from "./sessions.js";
import { createMemoryRunRepository } from "./run-repository.js";
import {
  cancelRun,
  configureModelGatewayFactory,
  configureRunRepository,
  createRun,
  getRun,
  listRunEvents,
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
