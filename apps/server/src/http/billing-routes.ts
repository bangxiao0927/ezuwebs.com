import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuthServicePort } from "./auth-routes.js";
import { readJsonBody } from "./body.js";
import { parseCookies } from "./cookies.js";
import {
  DevGrantsDisabledError,
  UnknownDevGrantPackageError,
  getBillingSummary,
  grantDevCredits,
  listBillingUsage,
} from "../domain/billing/billing-service.js";

type SendJson = (response: ServerResponse, status: number, payload: unknown) => void;

function parseOptionalInt(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function handleBillingRoute(
  segments: string[],
  method: string,
  request: IncomingMessage,
  response: ServerResponse,
  authService: AuthServicePort,
  sendJson: SendJson,
): Promise<boolean> {
  if (segments[1] !== "billing") {
    return false;
  }

  const sessionCookieValue = parseCookies(request.headers.cookie)[authService.sessionCookieName];
  const user = await authService.getCurrentUser(sessionCookieValue);
  if (!user) {
    sendJson(response, 401, { error: "Authentication required" });
    return true;
  }

  if (segments.length === 3 && segments[2] === "summary" && method === "GET") {
    sendJson(response, 200, await getBillingSummary(user.id));
    return true;
  }

  if (segments.length === 3 && segments[2] === "usage" && method === "GET") {
    const url = new URL(request.url ?? "/", "http://localhost");
    const limit = parseOptionalInt(url.searchParams.get("limit"));
    const offset = parseOptionalInt(url.searchParams.get("offset"));
    sendJson(
      response,
      200,
      await listBillingUsage(user.id, {
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      }),
    );
    return true;
  }

  if (segments.length === 3 && segments[2] === "dev-grant" && method === "POST") {
    const body = await readJsonBody<{ packageId?: string }>(request);
    try {
      sendJson(response, 200, await grantDevCredits(user.id, body.packageId ?? ""));
    } catch (error) {
      if (error instanceof DevGrantsDisabledError) {
        sendJson(response, 404, { error: "Not found" });
        return true;
      }
      if (error instanceof UnknownDevGrantPackageError) {
        sendJson(response, 400, { error: error.message });
        return true;
      }
      throw error;
    }
    return true;
  }

  return false;
}
