import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { createApiHandler } from "./router.js";
import type { AuthServicePort } from "./auth-routes.js";
import type { AuthUser } from "../domain/auth/store.js";
import {
  FREE_GRANT_CREDITS,
  USAGE_COSTS,
  chargeUsage,
  configureBillingStore,
  getBillingSummary,
} from "../domain/billing/billing-service.js";
import { createMemoryBillingStore } from "../domain/billing/memory-billing-store.js";
import { configureSessionRepository } from "../domain/sessions.js";
import { createMemorySessionRepository } from "../domain/session-repository.js";

const USER_A: AuthUser = { id: "user-a", email: "a@example.com", plan: "free" };

function createFakeAuthService(currentUser: AuthUser | undefined): AuthServicePort {
  return {
    sessionCookieName: "ezu_session",
    transactionCookieName: "ezu_oauth_txn",
    beginGoogleLogin: () => {
      throw new Error("not used in this test");
    },
    completeGoogleLogin: async () => {
      throw new Error("not used in this test");
    },
    getCurrentUser: async (sessionCookieValue) =>
      sessionCookieValue === "valid-session" ? currentUser : undefined,
    logout: async () => ({ clearCookie: "ezu_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT" }),
  };
}

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const handler = createApiHandler({ authService: createFakeAuthService(USER_A) });
  const server: Server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function drainBalanceLeaving(userId: string, remainingCredits: number): Promise<void> {
  await getBillingSummary(userId);
  let balance = await getBillingSummary(userId);
  let requestCounter = 0;
  while (balance.balance > remainingCredits) {
    requestCounter += 1;
    await chargeUsage({ userId, kind: "prompt", requestId: `drain-${requestCounter}` });
    balance = await getBillingSummary(userId);
  }
}

test("POST /api/sessions/:id/prompt returns 402 and does not run the agent when credits are insufficient", async () => {
  configureSessionRepository(createMemorySessionRepository());
  configureBillingStore(createMemoryBillingStore());
  await drainBalanceLeaving(USER_A.id, USAGE_COSTS["prompt"]! - 1);

  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ definitionId: "club-promo" }),
    });
    const { session } = (await created.json()) as { session: { id: string; viewModel: { chatMessages: unknown[] } } };
    const messageCountBefore = session.viewModel.chatMessages.length;

    const response = await fetch(`${baseUrl}/api/sessions/${session.id}/prompt`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "ezu_session=valid-session",
        "idempotency-key": "prompt-insufficient-1",
      },
      body: JSON.stringify({ text: "Make the hero more concise" }),
    });
    assert.equal(response.status, 402);

    const reloaded = await fetch(`${baseUrl}/api/sessions/${session.id}`, {
      headers: { cookie: "ezu_session=valid-session" },
    });
    const { session: reloadedSession } = (await reloaded.json()) as {
      session: { viewModel: { chatMessages: unknown[] } };
    };
    assert.equal(reloadedSession.viewModel.chatMessages.length, messageCountBefore);
  });
});

test("POST /api/sessions/:id/prompt debits credits on success and reflects the new balance in the summary", async () => {
  configureSessionRepository(createMemorySessionRepository());
  configureBillingStore(createMemoryBillingStore());

  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ definitionId: "club-promo" }),
    });
    const { session } = (await created.json()) as { session: { id: string } };

    const response = await fetch(`${baseUrl}/api/sessions/${session.id}/prompt`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "ezu_session=valid-session",
        "idempotency-key": "prompt-success-1",
      },
      body: JSON.stringify({ text: "Make the hero more concise" }),
    });
    assert.equal(response.status, 200);

    const summary = await fetch(`${baseUrl}/api/billing/summary`, {
      headers: { cookie: "ezu_session=valid-session" },
    });
    const body = (await summary.json()) as { balance: number };
    assert.equal(body.balance, FREE_GRANT_CREDITS - USAGE_COSTS["prompt"]!);
  });
});

test("POST /api/sessions/:id/prompt requires authentication once billing is enabled", async () => {
  configureSessionRepository(createMemorySessionRepository());
  configureBillingStore(createMemoryBillingStore());

  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ definitionId: "club-promo" }),
    });
    const { session } = (await created.json()) as { session: { id: string } };

    const response = await fetch(`${baseUrl}/api/sessions/${session.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "anon-prompt-1" },
      body: JSON.stringify({ text: "Make the hero more concise" }),
    });
    assert.equal(response.status, 401);
  });
});

test("POST /api/sessions requires authentication once billing is enabled", async () => {
  configureSessionRepository(createMemorySessionRepository());
  configureBillingStore(createMemoryBillingStore());

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "club-promo" }),
    });

    assert.equal(response.status, 401);
  });
});

test("POST /api/sessions/:id/prompt requires an Idempotency-Key or requestId once authenticated", async () => {
  configureSessionRepository(createMemorySessionRepository());
  configureBillingStore(createMemoryBillingStore());

  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ definitionId: "club-promo" }),
    });
    const { session } = (await created.json()) as { session: { id: string } };

    const response = await fetch(`${baseUrl}/api/sessions/${session.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ text: "Make the hero more concise" }),
    });
    assert.equal(response.status, 400);
  });
});

test("POST /api/sessions/:id/prompt replaying the same Idempotency-Key does not debit twice or duplicate messages", async () => {
  configureSessionRepository(createMemorySessionRepository());
  configureBillingStore(createMemoryBillingStore());

  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ definitionId: "club-promo" }),
    });
    const { session } = (await created.json()) as { session: { id: string } };

    const requestHeaders = {
      "content-type": "application/json",
      cookie: "ezu_session=valid-session",
      "idempotency-key": "replay-1",
    };
    const requestBody = JSON.stringify({ text: "Make the hero more concise" });

    const first = await fetch(`${baseUrl}/api/sessions/${session.id}/prompt`, {
      method: "POST",
      headers: requestHeaders,
      body: requestBody,
    });
    const firstBody = (await first.json()) as { session: { viewModel: { chatMessages: unknown[] } } };

    const replay = await fetch(`${baseUrl}/api/sessions/${session.id}/prompt`, {
      method: "POST",
      headers: requestHeaders,
      body: requestBody,
    });
    const replayBody = (await replay.json()) as { session: { viewModel: { chatMessages: unknown[] } } };

    assert.equal(replay.status, 200);
    assert.equal(
      replayBody.session.viewModel.chatMessages.length,
      firstBody.session.viewModel.chatMessages.length,
    );

    const summary = await fetch(`${baseUrl}/api/billing/summary`, {
      headers: { cookie: "ezu_session=valid-session" },
    });
    const summaryBody = (await summary.json()) as { balance: number };
    assert.equal(summaryBody.balance, FREE_GRANT_CREDITS - USAGE_COSTS["prompt"]!);
  });
});

test("POST /api/sessions/:id/edit requires authentication once billing is enabled", async () => {
  configureSessionRepository(createMemorySessionRepository());
  configureBillingStore(createMemoryBillingStore());

  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ definitionId: "club-promo" }),
    });
    const { session } = (await created.json()) as { session: { id: string } };

    const response = await fetch(`${baseUrl}/api/sessions/${session.id}/edit`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "anon-edit-1" },
      body: JSON.stringify({ intent: "Tighten the copy", patchStrategy: "refine" }),
    });
    assert.equal(response.status, 401);
  });
});

test("POST /api/sessions/:id/edit does not require idempotency when runAgent is false (no charge)", async () => {
  configureSessionRepository(createMemorySessionRepository());
  configureBillingStore(createMemoryBillingStore());

  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ definitionId: "club-promo" }),
    });
    const { session } = (await created.json()) as { session: { id: string } };

    const response = await fetch(`${baseUrl}/api/sessions/${session.id}/edit`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ intent: "Tighten the copy", patchStrategy: "refine", runAgent: false }),
    });
    assert.equal(response.status, 200);
  });
});

test("POST /api/sessions/:id/edit replaying the same Idempotency-Key does not debit twice", async () => {
  configureSessionRepository(createMemorySessionRepository());
  configureBillingStore(createMemoryBillingStore());

  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ definitionId: "club-promo" }),
    });
    const { session } = (await created.json()) as { session: { id: string } };

    const requestHeaders = {
      "content-type": "application/json",
      cookie: "ezu_session=valid-session",
      "idempotency-key": "edit-replay-1",
    };
    const requestBody = JSON.stringify({ intent: "Tighten the copy", patchStrategy: "refine" });

    const first = await fetch(`${baseUrl}/api/sessions/${session.id}/edit`, {
      method: "POST",
      headers: requestHeaders,
      body: requestBody,
    });
    assert.equal(first.status, 200);

    const replay = await fetch(`${baseUrl}/api/sessions/${session.id}/edit`, {
      method: "POST",
      headers: requestHeaders,
      body: requestBody,
    });
    assert.equal(replay.status, 200);

    const summary = await fetch(`${baseUrl}/api/billing/summary`, {
      headers: { cookie: "ezu_session=valid-session" },
    });
    const summaryBody = (await summary.json()) as { balance: number };
    assert.equal(summaryBody.balance, FREE_GRANT_CREDITS - USAGE_COSTS["edit"]!);
  });
});

test("POST /api/sessions/:id/approval requires authentication once billing is enabled", async () => {
  configureSessionRepository(createMemorySessionRepository());
  configureBillingStore(createMemoryBillingStore());

  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ definitionId: "club-promo" }),
    });
    const { session } = (await created.json()) as {
      session: { id: string; viewModel: { pendingInteraction?: { id: string } } };
    };
    const interactionId = session.viewModel.pendingInteraction?.id;
    assert.ok(interactionId, "session should start with a pending confirm interaction");

    const response = await fetch(`${baseUrl}/api/sessions/${session.id}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ interactionId, decision: "approved" }),
    });
    assert.equal(response.status, 401);
  });
});

test("POST /api/sessions/:id/approval executes for the authenticated owner without charging additional credits", async () => {
  configureSessionRepository(createMemorySessionRepository());
  configureBillingStore(createMemoryBillingStore());

  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ definitionId: "club-promo" }),
    });
    const { session } = (await created.json()) as {
      session: { id: string; viewModel: { pendingInteraction?: { id: string } } };
    };
    const interactionId = session.viewModel.pendingInteraction?.id;

    const response = await fetch(`${baseUrl}/api/sessions/${session.id}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ interactionId, decision: "approved" }),
    });
    assert.equal(response.status, 200);

    const summary = await fetch(`${baseUrl}/api/billing/summary`, {
      headers: { cookie: "ezu_session=valid-session" },
    });
    const summaryBody = (await summary.json()) as { balance: number };
    assert.equal(summaryBody.balance, FREE_GRANT_CREDITS);
  });
});

async function createApprovedSessionWithActionId(
  baseUrl: string,
): Promise<{ sessionId: string; actionId: string }> {
  const created = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
    body: JSON.stringify({ definitionId: "club-promo" }),
  });
  const { session } = (await created.json()) as {
    session: { id: string; viewModel: { pendingInteraction?: { id: string; actionId?: string } } };
  };
  const interaction = session.viewModel.pendingInteraction;
  assert.ok(interaction?.actionId, "the confirm interaction should gate a specific action");

  await fetch(`${baseUrl}/api/sessions/${session.id}/approval`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
    body: JSON.stringify({ interactionId: interaction.id, decision: "approved" }),
  });

  return { sessionId: session.id, actionId: interaction.actionId! };
}

test("POST /api/sessions/:id/actions/:actionId/retry requires authentication once billing is enabled", async () => {
  configureSessionRepository(createMemorySessionRepository());
  configureBillingStore(createMemoryBillingStore());

  await withServer(async (baseUrl) => {
    const { sessionId, actionId } = await createApprovedSessionWithActionId(baseUrl);

    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/actions/${actionId}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "anon-retry-1" },
    });
    assert.equal(response.status, 401);
  });
});

test("POST /api/sessions/:id/actions/:actionId/retry requires an Idempotency-Key once authenticated", async () => {
  configureSessionRepository(createMemorySessionRepository());
  configureBillingStore(createMemoryBillingStore());

  await withServer(async (baseUrl) => {
    const { sessionId, actionId } = await createApprovedSessionWithActionId(baseUrl);

    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/actions/${actionId}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
    });
    assert.equal(response.status, 400);
  });
});
