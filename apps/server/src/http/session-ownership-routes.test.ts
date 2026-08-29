import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { createApiHandler } from "./router.js";
import type { AuthServicePort } from "./auth-routes.js";
import type { AuthUser } from "../domain/auth/store.js";

const USER_A: AuthUser = { id: "user-a", email: "a@example.com", plan: "free" };
const USER_B: AuthUser = { id: "user-b", email: "b@example.com", plan: "free" };

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

async function withServer(
  authService: AuthServicePort,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const handler = createApiHandler({ authService });
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

test("GET /api/sessions/:id is not accessible to a different signed-in user than the owner", async () => {
  let sessionId = "";
  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ definitionId: "club-promo" }),
    });
    const body = (await created.json()) as { session: { id: string } };
    sessionId = body.session.id;
  });

  await withServer(createFakeAuthService(USER_B), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      headers: { cookie: "ezu_session=valid-session" },
    });
    assert.equal(response.status, 404);
  });

  await withServer(createFakeAuthService(undefined), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`);
    assert.equal(response.status, 404);
  });
});

test("GET /api/sessions/:id remains accessible to the owner", async () => {
  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ definitionId: "club-promo" }),
    });
    const body = (await created.json()) as { session: { id: string } };

    const response = await fetch(`${baseUrl}/api/sessions/${body.session.id}`, {
      headers: { cookie: "ezu_session=valid-session" },
    });
    assert.equal(response.status, 200);
  });
});

test("GET /api/sessions lists demo definitions publicly, without requiring a session cookie", async () => {
  await withServer(createFakeAuthService(undefined), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions`);
    const body = (await response.json()) as { sessions: unknown[] };

    assert.equal(response.status, 200);
    assert.ok(body.sessions.length > 0);
  });
});
