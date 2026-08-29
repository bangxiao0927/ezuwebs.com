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
  while (balance.balance > remainingCredits) {
    await chargeUsage(userId, { kind: "prompt" });
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
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
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
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
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
