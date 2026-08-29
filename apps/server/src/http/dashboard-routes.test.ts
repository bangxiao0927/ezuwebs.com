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

test("GET /api/dashboard returns 401 when there is no session cookie", async () => {
  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/dashboard`);
    assert.equal(response.status, 401);
  });
});

test("GET /api/dashboard ignores a userId query parameter and always uses the session cookie", async () => {
  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/dashboard?userId=someone-else`, {
      headers: { cookie: "ezu_session=valid-session" },
    });
    const body = (await response.json()) as { user: { id: string } };

    assert.equal(response.status, 200);
    assert.equal(body.user.id, "user-a");
  });
});

test("GET /api/dashboard returns an empty project list for a user with no sessions", async () => {
  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/dashboard`, {
      headers: { cookie: "ezu_session=valid-session" },
    });
    const body = (await response.json()) as {
      user: unknown;
      projects: unknown[];
      counts: { totalProjects: number };
    };

    assert.equal(response.status, 200);
    assert.deepEqual(body.projects, []);
    assert.equal(body.counts.totalProjects, 0);
  });
});

test("GET /api/dashboard isolates projects between users: user A cannot see user B's sessions", async () => {
  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
      body: JSON.stringify({ definitionId: "club-promo" }),
    });
    assert.equal(created.status, 201);
  });

  await withServer(createFakeAuthService(USER_B), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/dashboard`, {
      headers: { cookie: "ezu_session=valid-session" },
    });
    const body = (await response.json()) as { projects: unknown[] };

    assert.equal(response.status, 200);
    assert.deepEqual(body.projects, []);
  });
});

test("GET /api/dashboard does not leak internal fields like tokens or password hashes", async () => {
  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/dashboard`, {
      headers: { cookie: "ezu_session=valid-session" },
    });
    const raw = await response.text();

    assert.doesNotMatch(raw, /token/i);
    assert.doesNotMatch(raw, /hash/i);
    assert.doesNotMatch(raw, /password/i);
  });
});
