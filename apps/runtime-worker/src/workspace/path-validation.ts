export class WorkspacePathError extends Error {}

const maxPathLength = 4096;

/**
 * Re-validates a workspace path on the worker side, independent of any
 * client-side validation: this is the last line of defense before a path
 * is used to address a file inside a runtime's workspace.
 */
export function validateWorkspacePath(path: string, options: { allowEmpty?: boolean } = {}): string {
  if (typeof path !== "string") {
    throw new WorkspacePathError("path must be a string");
  }

  if (path.length === 0) {
    if (options.allowEmpty) {
      return path;
    }
    throw new WorkspacePathError("path must not be empty");
  }

  if (path.length > maxPathLength) {
    throw new WorkspacePathError(`path must not exceed ${maxPathLength} characters`);
  }

  if (path.includes("\0")) {
    throw new WorkspacePathError("path must not contain a NUL byte");
  }

  if (path.includes("\\")) {
    throw new WorkspacePathError("path must use POSIX '/' separators, not backslashes");
  }

  if (path.startsWith("/")) {
    throw new WorkspacePathError("path must be relative, not absolute");
  }

  if (/^[A-Za-z]:/.test(path)) {
    throw new WorkspacePathError("path must not be a drive-letter absolute path");
  }

  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new WorkspacePathError("path must not contain empty segments (e.g. a doubled '/')");
    }
    if (segment === "." || segment === "..") {
      throw new WorkspacePathError("path must not contain '.' or '..' segments");
    }
  }

  return path;
}
