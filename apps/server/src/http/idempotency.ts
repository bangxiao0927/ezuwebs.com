import type { IncomingMessage } from "node:http";

/**
 * Resolves the client-supplied idempotency key for a request: the
 * `Idempotency-Key` header wins over a `requestId` field in the JSON body.
 */
export function resolveRequestId(
  request: IncomingMessage,
  body: { requestId?: string },
): string | undefined {
  const header = request.headers["idempotency-key"];
  const headerValue = Array.isArray(header) ? header[0] : header;
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }
  if (typeof body.requestId === "string" && body.requestId.trim()) {
    return body.requestId.trim();
  }
  return undefined;
}
