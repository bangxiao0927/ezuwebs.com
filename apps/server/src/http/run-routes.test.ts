import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { type AgentEvent } from "@ezu/protocol";
import type { ModelGateway, PlannerInput } from "@ezu/model-gateway";

import { createApiHandler } from "./router.js";
import type { AuthServicePort } from "./auth-routes.js";
import type { AuthUser } from "../domain/auth/store.js";
import { createMemorySessionRepository } from "../domain/session-repository.js";
import { configureSessionRepository } from "../domain/sessions.js";
import { createMemoryBillingStore } from "../domain/billing/memory-billing-store.js";
import { configureBillingStore } from "../domain/billing/billing-service.js";
import { createMemoryRunRepository } from "../domain/run-repository.js";
import { configureModelGatewayFactory, configureRunRepository } from "../domain/run-service.js";

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

function resetDomainState(): void {
  configureSessionRepository(createMemorySessionRepository());
  configureBillingStore(createMemoryBillingStore());
  configureRunRepository(createMemoryRunRepository());
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

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}

async function createOwnedSession(baseUrl: string): Promise<string> {
  const created = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "ezu_session=valid-session" },
    body: JSON.stringify({ definitionId: "club-promo" }),
  });
  const body = (await created.json()) as { session: { id: string } };
  return body.session.id;
}

test("POST /api/sessions/:id/runs starts a run and GET reflects its terminal state", async () => {
  resetDomainState();
  configureModelGatewayFactory(() =>
    fakeGatewayEmitting([{ type: "message.delta", messageId: "m1", text: "hi" }]),
  );

  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    const sessionId = await createOwnedSession(baseUrl);

    const created = await fetch(`${baseUrl}/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "ezu_session=valid-session",
        "idempotency-key": "req-1",
      },
      body: JSON.stringify({ kind: "prompt", text: "Do the thing" }),
    });
    assert.equal(created.status, 202);
    const createdBody = (await created.json()) as { run: { id: string; status: string } };
    assert.equal(createdBody.run.status, "queued");

    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/runs/${createdBody.run.id}`, {
        headers: { cookie: "ezu_session=valid-session" },
      });
      const body = (await response.json()) as { run: { status: string } };
      return body.run.status === "completed";
    });
  });
});

test("GET /api/sessions/:id/runs/:runId/events replays persisted events and streams live ones", async () => {
  resetDomainState();
  configureModelGatewayFactory(() =>
    fakeGatewayEmitting([
      { type: "message.delta", messageId: "m1", text: "chunk-1" },
      { type: "message.delta", messageId: "m1", text: "chunk-2" },
    ]),
  );

  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    const sessionId = await createOwnedSession(baseUrl);
    const created = await fetch(`${baseUrl}/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "ezu_session=valid-session",
        "idempotency-key": "req-1",
      },
      body: JSON.stringify({ kind: "prompt", text: "Do the thing" }),
    });
    const { run } = (await created.json()) as { run: { id: string } };

    const eventsResponse = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/runs/${run.id}/events?afterSeq=0`,
      { headers: { cookie: "ezu_session=valid-session" } },
    );
    assert.equal(eventsResponse.status, 200);
    assert.equal(eventsResponse.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(eventsResponse.headers.get("cache-control"), "no-store");

    const text = await eventsResponse.text();
    const dataLines = text.split("\n\n").filter((frame) => frame.startsWith("id:"));
    assert.ok(dataLines.length >= 3, "expected at least the user message and two delta events");
    assert.ok(dataLines.every((frame) => frame.includes("event: agent")));
    const lastFrame = dataLines.at(-1)!;
    const dataLine = lastFrame.split("\n").find((line) => line.startsWith("data:"))!;
    const lastEvent = JSON.parse(dataLine.slice("data:".length).trim()) as AgentEvent;
    assert.equal(lastEvent.type, "message.delta");
    assert.equal((lastEvent as Extract<AgentEvent, { type: "message.delta" }>).text, "chunk-2");
  });
});

test("GET /api/sessions/:id/runs/:runId rejects afterSeq that is not a non-negative integer", async () => {
  resetDomainState();
  configureModelGatewayFactory(() => fakeGatewayEmitting([]));

  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    const sessionId = await createOwnedSession(baseUrl);
    const created = await fetch(`${baseUrl}/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "ezu_session=valid-session",
        "idempotency-key": "req-1",
      },
      body: JSON.stringify({ kind: "prompt", text: "Do the thing" }),
    });
    const { run } = (await created.json()) as { run: { id: string } };

    const response = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/runs/${run.id}/events?afterSeq=-1`,
      { headers: { cookie: "ezu_session=valid-session" } },
    );
    assert.equal(response.status, 400);
  });
});

test("a run is not visible to a different signed-in user than its owner", async () => {
  resetDomainState();
  configureModelGatewayFactory(() => fakeGatewayEmitting([]));
  let sessionId = "";
  let runId = "";

  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    sessionId = await createOwnedSession(baseUrl);
    const created = await fetch(`${baseUrl}/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "ezu_session=valid-session",
        "idempotency-key": "req-1",
      },
      body: JSON.stringify({ kind: "prompt", text: "hi" }),
    });
    const body = (await created.json()) as { run: { id: string } };
    runId = body.run.id;
  });

  await withServer(createFakeAuthService(USER_B), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/runs/${runId}`, {
      headers: { cookie: "ezu_session=valid-session" },
    });
    assert.equal(response.status, 404);
  });
});

test("POST /api/sessions/:id/runs/:runId/cancel persists cancellation and the run reaches cancelled", async () => {
  resetDomainState();
  configureModelGatewayFactory(() =>
    fakeGatewayEmitting([{ type: "message.delta", messageId: "m1", text: "still going" }], { hang: true }),
  );

  await withServer(createFakeAuthService(USER_A), async (baseUrl) => {
    const sessionId = await createOwnedSession(baseUrl);
    const created = await fetch(`${baseUrl}/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "ezu_session=valid-session",
        "idempotency-key": "req-1",
      },
      body: JSON.stringify({ kind: "prompt", text: "hi" }),
    });
    const { run } = (await created.json()) as { run: { id: string } };

    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/runs/${run.id}`, {
        headers: { cookie: "ezu_session=valid-session" },
      });
      const body = (await response.json()) as { run: { status: string } };
      return body.run.status === "running";
    });

    const cancelResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/runs/${run.id}/cancel`, {
      method: "POST",
      headers: { cookie: "ezu_session=valid-session" },
    });
    assert.equal(cancelResponse.status, 200);

    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/runs/${run.id}`, {
        headers: { cookie: "ezu_session=valid-session" },
      });
      const body = (await response.json()) as { run: { status: string } };
      return body.run.status === "cancelled";
    });
  });
});
