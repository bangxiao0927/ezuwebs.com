import crypto from "node:crypto";

export function base64UrlEncode(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateRandomToken(byteLength = 32): string {
  return base64UrlEncode(crypto.randomBytes(byteLength));
}

export function computeCodeChallengeS256(verifier: string): string {
  const hash = crypto.createHash("sha256").update(verifier).digest();
  return base64UrlEncode(hash);
}
