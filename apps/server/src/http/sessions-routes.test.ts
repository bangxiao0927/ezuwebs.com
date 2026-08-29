import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { createApiHandler } from "./router.js";

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

async function createTestSession(baseUrl: string): Promise<{ id: string; interactionId: string }> {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ definitionId: "club-promo" }),
  });
  const body = (await response.json()) as {
    session: { id: string; viewModel: { pendingInteraction?: { id: string } } };
  };
  const interactionId = body.session.viewModel.pendingInteraction?.id;
  assert.ok(interactionId, "session should start with a pending confirm interaction");
  return { id: body.session.id, interactionId };
}

test("POST /api/sessions/:id/interaction requires an interactionId", async () => {
  await withServer(async (baseUrl) => {
    const { id } = await createTestSession(baseUrl);

    const response = await fetch(`${baseUrl}/api/sessions/${id}/interaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optionId: "opt-a" }),
    });

    assert.equal(response.status, 400);
  });
});

test("POST /api/sessions/:id/interaction requires an optionId or value", async () => {
  await withServer(async (baseUrl) => {
    const { id, interactionId } = await createTestSession(baseUrl);

    const response = await fetch(`${baseUrl}/api/sessions/${id}/interaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ interactionId }),
    });

    assert.equal(response.status, 400);
  });
});

test("POST /api/sessions/:id/interaction returns 409 when the pending interaction is not a choice or input", async () => {
  await withServer(async (baseUrl) => {
    const { id, interactionId } = await createTestSession(baseUrl);

    const response = await fetch(`${baseUrl}/api/sessions/${id}/interaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ interactionId, optionId: "opt-a" }),
    });

    assert.equal(response.status, 409);
  });
});

test("POST /api/sessions/:id/approval executes the gated action exactly once and rejects a second attempt", async () => {
  await withServer(async (baseUrl) => {
    const { id, interactionId } = await createTestSession(baseUrl);

    const approve = await fetch(`${baseUrl}/api/sessions/${id}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ interactionId, decision: "approved" }),
    });
    assert.equal(approve.status, 200);
    const approved = (await approve.json()) as {
      session: { viewModel: { previews: unknown[] } };
    };
    assert.ok(approved.session.viewModel.previews.length > 0);

    const secondApprove = await fetch(`${baseUrl}/api/sessions/${id}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ interactionId, decision: "approved" }),
    });
    assert.equal(secondApprove.status, 409);
  });
});
