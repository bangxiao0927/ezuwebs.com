export interface Route {
  name: "launcher" | "select" | "session" | "dashboard" | "credits" | "usage";
  sessionId?: string;
}

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "");
  const sessionMatch = /^\/session\/([^/?#]+)/.exec(path);
  if (sessionMatch) {
    return { name: "session", sessionId: decodeURIComponent(sessionMatch[1]!) };
  }
  if (/^\/select/.test(path)) {
    return { name: "select" };
  }
  if (/^\/dashboard/.test(path)) {
    return { name: "dashboard" };
  }
  if (/^\/credits/.test(path)) {
    return { name: "credits" };
  }
  if (/^\/usage/.test(path)) {
    return { name: "usage" };
  }
  return { name: "launcher" };
}
