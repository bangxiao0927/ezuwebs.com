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

test("GET /api/sessions does not send CORS headers for a same-origin request (no Origin header)", async () => {
  delete process.env["WEB_APP_URL"];
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });
});

test("GET /api/sessions rejects an Origin that does not match WEB_APP_URL", async () => {
  process.env["WEB_APP_URL"] = "https://app.ezuwebs.com";
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions`, {
      headers: { origin: "https://evil.example.com" },
    });
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });
  delete process.env["WEB_APP_URL"];
});

test("GET /api/sessions echoes the exact WEB_APP_URL origin with credentials and Vary: Origin", async () => {
  process.env["WEB_APP_URL"] = "https://app.ezuwebs.com";
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions`, {
      headers: { origin: "https://app.ezuwebs.com" },
    });
    assert.equal(response.headers.get("access-control-allow-origin"), "https://app.ezuwebs.com");
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    assert.equal(response.headers.get("vary"), "Origin");
  });
  delete process.env["WEB_APP_URL"];
});

test("OPTIONS preflight for an allowed cross-origin request advertises allowed headers and methods", async () => {
  process.env["WEB_APP_URL"] = "https://app.ezuwebs.com";
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: "OPTIONS",
      headers: { origin: "https://app.ezuwebs.com" },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://app.ezuwebs.com");
    assert.equal(response.headers.get("access-control-allow-headers"), "content-type, idempotency-key");
    assert.equal(response.headers.get("access-control-allow-methods"), "GET,POST,OPTIONS");
  });
  delete process.env["WEB_APP_URL"];
});

test("GET /api/sessions responds with Cache-Control: no-store", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sessions`);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});
