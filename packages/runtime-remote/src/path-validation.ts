import { RemoteRuntimeValidationError } from "./errors.js";

const maxPathLength = 4096;

/**
 * Validates a client-supplied workspace path before it is sent to the
 * worker. The worker must still re-validate: this only stops obviously
 * malicious or malformed paths from leaving this process.
 */
export function validateWorkspacePath(path: string, options: { allowEmpty?: boolean } = {}): string {
  if (typeof path !== "string") {
    throw new RemoteRuntimeValidationError("path must be a string");
  }

  if (path.length === 0) {
    if (options.allowEmpty) {
      return path;
    }
    throw new RemoteRuntimeValidationError("path must not be empty");
  }

  if (path.length > maxPathLength) {
    throw new RemoteRuntimeValidationError(`path must not exceed ${maxPathLength} characters`);
  }

  if (path.includes("\0")) {
    throw new RemoteRuntimeValidationError("path must not contain a NUL byte");
  }

  if (path.includes("\\")) {
    throw new RemoteRuntimeValidationError("path must use POSIX '/' separators, not backslashes");
  }

  if (path.startsWith("/")) {
    throw new RemoteRuntimeValidationError("path must be relative, not absolute");
  }

  if (/^[A-Za-z]:/.test(path)) {
    throw new RemoteRuntimeValidationError("path must not be a drive-letter absolute path");
  }

  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new RemoteRuntimeValidationError("path must not contain empty segments (e.g. a doubled '/')");
    }
    if (segment === "." || segment === "..") {
      throw new RemoteRuntimeValidationError("path must not contain '.' or '..' segments");
    }
  }

  return path;
}
