import crypto from "node:crypto";

export interface GoogleJsonWebKey {
  kty: string;
  kid: string;
  n: string;
  e: string;
}

export type FetchJwks = () => Promise<{ keys: GoogleJsonWebKey[] }>;

export interface VerifiedIdTokenClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  aud: string;
  iss: string;
  exp: number;
}

export interface VerifyIdTokenOptions {
  audience: string;
  expectedNonce: string;
  fetchJwks: FetchJwks;
  now?: () => number;
}

const ALLOWED_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export class IdTokenVerificationError extends Error {}

function base64UrlDecode(segment: string): Buffer {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

export async function verifyGoogleIdToken(
  idToken: string,
  options: VerifyIdTokenOptions,
): Promise<VerifiedIdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new IdTokenVerificationError("Malformed ID token");
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  const header = JSON.parse(base64UrlDecode(headerSegment).toString("utf8")) as {
    alg?: string;
    kid?: string;
  };
  if (header.alg !== "RS256" || !header.kid) {
    throw new IdTokenVerificationError("Unsupported ID token algorithm");
  }

  const jwks = await options.fetchJwks();
  const jwk = jwks.keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    throw new IdTokenVerificationError("No matching JWKS key found for ID token");
  }

  const publicKey = crypto.createPublicKey({
    key: { kty: jwk.kty, n: jwk.n, e: jwk.e },
    format: "jwk",
  });

  const signedData = `${headerSegment}.${payloadSegment}`;
  const signature = base64UrlDecode(signatureSegment);
  const signatureValid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(signedData, "utf8"),
    publicKey,
    signature,
  );
  if (!signatureValid) {
    throw new IdTokenVerificationError("Invalid ID token signature");
  }

  const payload = JSON.parse(base64UrlDecode(payloadSegment).toString("utf8")) as Record<string, unknown>;

  const iss = payload["iss"];
  if (typeof iss !== "string" || !ALLOWED_ISSUERS.has(iss)) {
    throw new IdTokenVerificationError("Unexpected ID token issuer");
  }

  const aud = payload["aud"];
  if (aud !== options.audience) {
    throw new IdTokenVerificationError("Unexpected ID token audience");
  }

  const now = options.now ? options.now() : Math.floor(Date.now() / 1000);
  const exp = payload["exp"];
  if (typeof exp !== "number" || exp <= now) {
    throw new IdTokenVerificationError("ID token has expired");
  }

  const nonce = payload["nonce"];
  if (typeof nonce !== "string" || nonce !== options.expectedNonce) {
    throw new IdTokenVerificationError("ID token nonce mismatch");
  }

  const sub = payload["sub"];
  if (typeof sub !== "string" || !sub) {
    throw new IdTokenVerificationError("ID token is missing a subject claim");
  }

  const email = payload["email"];
  if (typeof email !== "string" || !email) {
    throw new IdTokenVerificationError("ID token is missing an email claim");
  }

  const emailVerified = payload["email_verified"];
  if (emailVerified !== true) {
    throw new IdTokenVerificationError("Google account email is not verified");
  }

  const name = payload["name"];
  const picture = payload["picture"];

  return {
    sub,
    email,
    emailVerified: true,
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof picture === "string" ? { picture } : {}),
    aud,
    iss,
    exp,
  };
}
