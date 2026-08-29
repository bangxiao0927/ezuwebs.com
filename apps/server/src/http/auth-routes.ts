import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuthUser } from "../domain/auth/store.js";
import { parseCookies, serializeCookie } from "./cookies.js";

export interface AuthServicePort {
  sessionCookieName: string;
  transactionCookieName: string;
  beginGoogleLogin(): { redirectUrl: string; transactionCookie: string };
  completeGoogleLogin(input: {
    code: string;
    state: string;
    transactionCookieValue: string | undefined;
  }): Promise<{ user: AuthUser; sessionCookie: string; clearTransactionCookie: string }>;
  getCurrentUser(sessionCookieValue: string | undefined): Promise<AuthUser | undefined>;
  logout(sessionCookieValue: string | undefined): Promise<{ clearCookie: string }>;
}

function webAppUrl(): string {
  return process.env.WEB_APP_URL ?? "/";
}

function withErrorFlag(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}authError=1`;
}

function sendRedirect(response: ServerResponse, location: string, cookies: string[] = []): void {
  if (cookies.length) {
    response.setHeader("set-cookie", cookies);
  }
  response.writeHead(302, { location });
  response.end();
}

export async function handleAuthRoute(
  segments: string[],
  method: string,
  request: IncomingMessage,
  response: ServerResponse,
  authService: AuthServicePort,
  sendJson: (response: ServerResponse, status: number, payload: unknown) => void,
): Promise<boolean> {
  if (segments[1] !== "auth") {
    return false;
  }

  if (segments.length === 3 && segments[2] === "google" && method === "GET") {
    const { redirectUrl, transactionCookie } = authService.beginGoogleLogin();
    sendRedirect(response, redirectUrl, [transactionCookie]);
    return true;
  }

  if (segments.length === 4 && segments[2] === "google" && segments[3] === "callback" && method === "GET") {
    const url = new URL(request.url ?? "/", "http://localhost");
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const transactionCookieValue = parseCookies(request.headers.cookie)[authService.transactionCookieName];

    try {
      const result = await authService.completeGoogleLogin({ code, state, transactionCookieValue });
      sendRedirect(response, webAppUrl(), [result.sessionCookie, result.clearTransactionCookie]);
    } catch {
      // Never leak provider or verification error details into the redirect the browser follows.
      sendRedirect(response, withErrorFlag(webAppUrl()), [
        serializeCookie(authService.transactionCookieName, "", {
          expires: new Date(0),
          secure: new URL(webAppUrl(), "http://localhost").protocol === "https:",
        }),
      ]);
    }
    return true;
  }

  if (segments.length === 3 && segments[2] === "me" && method === "GET") {
    const sessionCookieValue = parseCookies(request.headers.cookie)[authService.sessionCookieName];
    const user = await authService.getCurrentUser(sessionCookieValue);
    sendJson(response, 200, { user: user ?? null });
    return true;
  }

  if (segments.length === 3 && segments[2] === "logout" && method === "POST") {
    const sessionCookieValue = parseCookies(request.headers.cookie)[authService.sessionCookieName];
    const { clearCookie } = await authService.logout(sessionCookieValue);
    response.setHeader("set-cookie", clearCookie);
    sendJson(response, 200, { ok: true });
    return true;
  }

  return false;
}
