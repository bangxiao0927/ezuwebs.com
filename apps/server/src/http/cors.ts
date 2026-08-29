/**
 * Resolves the exact Access-Control-Allow-Origin value for a cross-origin
 * request. Same-origin requests never carry a browser Origin header that
 * differs from the server's own origin in the way this checks, so callers
 * should skip CORS headers entirely when this returns undefined.
 */
export function resolveAllowedOrigin(requestOrigin: string | undefined): string | undefined {
  const configured = process.env["WEB_APP_URL"];
  if (!requestOrigin || !configured) {
    return undefined;
  }
  try {
    return new URL(configured).origin === new URL(requestOrigin).origin ? requestOrigin : undefined;
  } catch {
    return undefined;
  }
}

export function corsHeaders(allowedOrigin: string | undefined): Record<string, string> {
  if (!allowedOrigin) {
    return {};
  }
  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
}
