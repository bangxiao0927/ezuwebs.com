import crypto from "node:crypto";

/** Hashes an opaque session token so only the hash, never the raw token, is stored. */
export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
