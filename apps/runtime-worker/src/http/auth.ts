import { timingSafeEqual } from "node:crypto";

const bearerPrefix = "Bearer ";

/**
 * Checks an `Authorization` header against the configured worker token
 * using a constant-time comparison, so a timing attack cannot narrow down
 * the token one byte at a time.
 */
export function isAuthorized(authorizationHeader: string | undefined, expectedToken: string): boolean {
  if (!authorizationHeader || !authorizationHeader.startsWith(bearerPrefix)) {
    return false;
  }

  const presented = Buffer.from(authorizationHeader.slice(bearerPrefix.length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");

  if (presented.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(presented, expected);
}
