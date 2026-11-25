import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createApiHandler } from "./http/router.js";

async function startApiServer(): Promise<{ baseUrl: string; server: Server }> {
  const handler = createApiHandler();
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("API classifies invalid client requests without enabling wildcard CORS", async () => {
  const { baseUrl, server } = await startApiServer();
  try {
    const malformed = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.headers.get("access-control-allow-origin"), null);

    const unknownDefinition = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "missing" }),
    });
    assert.equal(unknownDefinition.status, 400);

    const unknownSession = await fetch(`${baseUrl}/api/sessions/missing`);
    assert.equal(unknownSession.status, 404);

    const oversized = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "x".repeat(1024 * 1024) }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await stopServer(server);
  }
});

test("approval endpoint requires an explicit valid decision", async () => {
  const { baseUrl, server } = await startApiServer();
  try {
    const createResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "portfolio-dash" }),
    });
    const payload = (await createResponse.json()) as { session: { id: string } };

    const response = await fetch(`${baseUrl}/api/sessions/${payload.session.id}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "maybe" }),
    });
    assert.equal(response.status, 400);
  } finally {
    await stopServer(server);
  }
});
