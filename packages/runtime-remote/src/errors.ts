export class RemoteRuntimeError extends Error {}

/** Thrown when a {@link RemoteRuntimeConfig} fails validation at construction time. */
export class RemoteRuntimeConfigError extends RemoteRuntimeError {}

/** A worker path or command argument failed client-side validation before any request was sent. */
export class RemoteRuntimeValidationError extends RemoteRuntimeError {}

/** The worker did not respond to the connection within the configured connect timeout. */
export class RemoteRuntimeConnectTimeoutError extends RemoteRuntimeError {}

/** The worker accepted the connection but did not finish responding within the configured read timeout. */
export class RemoteRuntimeReadTimeoutError extends RemoteRuntimeError {}

/** The worker's response body exceeded the configured size limit. */
export class RemoteRuntimeResponseTooLargeError extends RemoteRuntimeError {}

/** The worker responded with a redirect (3xx) status, which this adapter never follows. */
export class RemoteRuntimeRedirectError extends RemoteRuntimeError {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The worker returned a runtime bound to a different sessionId than the one this adapter was configured for. */
export class RemoteRuntimeSessionMismatchError extends RemoteRuntimeError {}

/** The worker offered a preview URL this adapter's policy will not accept (wrong scheme or origin). */
export class RemoteRuntimePreviewRejectedError extends RemoteRuntimeError {}

/** The worker rejected a command or truncated its output under its own execution policy. */
export class RemoteRuntimePolicyError extends RemoteRuntimeError {}

/** The worker returned a response this adapter could not parse into the expected shape. */
export class RemoteRuntimeProtocolError extends RemoteRuntimeError {}

/**
 * The worker responded with a non-2xx status. `message` is a generic
 * summary safe to surface to an API caller: it never carries the request
 * body, the auth token, or the worker's response body. Callers that need to
 * diagnose the failure server-side should log `status` and consult the
 * worker's own logs rather than expecting detail here.
 */
export class RemoteRuntimeHttpError extends RemoteRuntimeError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
