import type { IncomingMessage } from "node:http";

/** Hard cap on request body size so a client cannot exhaust memory with an oversized payload. */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

export class PayloadTooLargeError extends Error {}

export async function readJsonBody<T>(
  request: IncomingMessage,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<T> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  let oversized = false;
  for await (const chunk of request) {
    receivedBytes += (chunk as Buffer).length;
    if (receivedBytes > maxBytes) {
      // Keep draining the stream instead of throwing immediately: Node will
      // not flush the response on this connection until the request body is
      // fully consumed, so bailing out early would stall the client.
      oversized = true;
      continue;
    }
    chunks.push(chunk as Buffer);
  }
  if (oversized) {
    throw new PayloadTooLargeError(`Request body exceeds the ${maxBytes}-byte limit`);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}
