export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (!name) {
      continue;
    }
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // An unrelated non-percent-encoded cookie must not break auth routes.
      cookies[name] = value;
    }
  }
  return cookies;
}

export interface CookieOptions {
  path?: string;
  maxAgeSeconds?: number;
  expires?: Date;
  secure?: boolean;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${options.path ?? "/"}`);
  segments.push("HttpOnly");
  segments.push("SameSite=Lax");
  if (options.secure ?? process.env.AUTH_COOKIE_SECURE !== "false") {
    segments.push("Secure");
  }
  if (typeof options.maxAgeSeconds === "number") {
    segments.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  if (options.expires) {
    segments.push(`Expires=${options.expires.toUTCString()}`);
  }
  return segments.join("; ");
}
