import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { createApiHandler } from "./router.js";
import { configureBillingEnabled } from "../domain/billing/billing-service.js";

// These tests exercise retry conflict handling, not billing, so they use the
// anonymous demo path rather than wiring up a fake auth service.
configureBillingEnabled(false);

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const handler = createApiHandler();
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

interface TestSession {
  id: string;
  interactionId: string;
  actionId: string;
}

async function createTestSession(baseUrl: string): Promise<TestSession> {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ definitionId: "club-promo" }),
  });
  const body = (await response.json()) as {
    session: {
      id: string;
      viewModel: { pendingInteraction?: { id: string; actionId?: string } };
    };
  };
  const interaction = body.session.viewModel.pendingInteraction;
  assert.ok(interaction?.id, "session should start with a pending confirm interaction");
  assert.ok(interaction.actionId, "the confirm interaction should gate a specific action");
  return { id: body.session.id, interactionId: interaction.id, actionId: interaction.actionId! };
}

test("POST /api/sessions/:id/actions/:actionId/retry rejects retrying an action that already completed", async () => {
  await withServer(async (baseUrl) => {
    const { id, interactionId, actionId } = await createTestSession(baseUrl);

    const approve = await fetch(`${baseUrl}/api/sessions/${id}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ interactionId, decision: "approved" }),
    });
    assert.equal(approve.status, 200);

    const retry = await fetch(`${baseUrl}/api/sessions/${id}/actions/${actionId}/retry`, {
      method: "POST",
    });
    assert.equal(retry.status, 409);
  });
});

test("POST /api/sessions/:id/actions/:actionId/retry rejects an unknown action id", async () => {
  await withServer(async (baseUrl) => {
    const { id } = await createTestSession(baseUrl);

    const retry = await fetch(`${baseUrl}/api/sessions/${id}/actions/does-not-exist/retry`, {
      method: "POST",
    });
    assert.equal(retry.status, 409);
  });
});
