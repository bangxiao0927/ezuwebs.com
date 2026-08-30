# @ezu/runtime-remote

A production `RuntimeAdapter` that delegates every file, command, and preview
operation to an HTTP sandbox worker instead of executing anything in the API
process. This package never runs a shell command, reads a filesystem path,
or opens a network socket to user code itself; it only ever speaks HTTP to
`config.baseUrl`.

## The worker contract

`RemoteRuntimeAdapter` expects the worker to implement this API under
`config.baseUrl`. All requests carry `Authorization: Bearer <apiToken>` and
JSON bodies.

- `POST /internal/runtime/v1/runtimes`
  Body: `{ sessionId, projectId, image, profile, limits, network: { egressDeny }, seed: { files: [{ path, content }] } }`.
  Response: `{ runtimeId, sessionId, status }`. Called lazily, at most once
  per adapter instance, on first use.
- `GET|PUT|PATCH|DELETE /internal/runtime/v1/runtimes/:runtimeId/files?path=...`
  Read, write (`{ path, content }`), patch (`{ path, patch }`), and delete a
  single file.
- `GET /internal/runtime/v1/runtimes/:runtimeId/files/list?root=...`
  Response: `{ files: string[] }`.
- `POST /internal/runtime/v1/runtimes/:runtimeId/commands`
  Body: `{ argv: string[], cwd?, timeoutMs, maxOutputBytes, policy }`. No
  shell string is ever sent; `argv` is already tokenized client-side.
  Response: `{ commandId, status }`.
- `GET /internal/runtime/v1/runtimes/:runtimeId/commands/:commandId`
  Response: `{ status: "running" | "exited", exitCode? }`.
- `GET /internal/runtime/v1/runtimes/:runtimeId/commands/:commandId/events?afterSeq=N`
  Response: `{ events: [{ seq, type: "output", chunk } | { seq, type: "exit", code }], nextSeq }`.
- `POST /internal/runtime/v1/runtimes/:runtimeId/commands/:commandId/cancel`
  Idempotent; safe to call more than once.
- `POST /internal/runtime/v1/runtimes/:runtimeId/previews`
  Body: `{ port? }`. Response: `{ port, url, status }`. `url` must be
  `https://` (or loopback `http://` only in local dev, see below).
- `GET /internal/runtime/v1/runtimes/:runtimeId/events?afterSeq=N`
  Combined file/port change feed. Response:
  `{ events: [{ seq, type: "file.changed", path, changeType } | { seq, type: "port.changed", port, url, status }], nextSeq }`.
- `DELETE /internal/runtime/v1/runtimes/:runtimeId`
  Releases the runtime; called from `dispose()`.

## Security responsibilities

This package validates paths, commands, and URLs before they leave the API
process, but **the worker must independently re-validate everything**: path
traversal, absolute paths, command argv, and output/file size limits. This
client is a second line of defense, not a substitute for the worker's own
sandboxing.

- `baseUrl` and `previewBaseUrl` must be `https://` in production. `http://`
  is only accepted for an explicit `127.0.0.1`/`localhost` host with
  `allowInsecureLoopback: true`, for local development against a fake or
  local worker. Neither URL may carry credentials, a query string, or a hash
  fragment. **`baseUrl` must come from server configuration, never from a
  request**: nothing in this package accepts it as request input.
- `runCommand` tokenizes its input into `argv` without ever invoking a
  shell, and rejects any of `; & | > < $ \` (backtick) newline` outright,
  even inside quotes.
- Workspace paths must be relative POSIX paths with no `..`/`.` segments,
  no backslashes, no NUL bytes, and no absolute or drive-letter prefixes.
- The worker's response to `openPreview` is rejected unless its scheme is
  https (or an allowed loopback) and, when `previewBaseUrl` is configured,
  its origin matches exactly.
- Errors never include the `Authorization` header or the request body, and
  truncate the worker's response body before including it in a message.

## Production environment

Configure the shared `@ezu/server` process to construct this adapter with:

| Env var | Purpose |
| --- | --- |
| `RUNTIME_PROVIDER=remote` | Selects this adapter instead of the in-process browser stub. |
| `RUNTIME_REMOTE_BASE_URL` | The worker's base URL. Must be `https://`. |
| `RUNTIME_REMOTE_TOKEN` | Bearer token sent on every request. |
| `RUNTIME_REMOTE_IMAGE` | Server-defined sandbox image passed to the worker. |
| `RUNTIME_REMOTE_PROFILE` | Server-defined resource profile (defaults to `default`). |
| `RUNTIME_REMOTE_COMMAND_POLICY` | Must be `network-deny`, acknowledging the worker denies sandbox network egress. |
| `RUNTIME_REMOTE_PREVIEW_BASE_URL` | Origin every preview URL must match. |
| `RUNTIME_REMOTE_ALLOW_INSECURE_LOOPBACK` | `true` only for local development against a loopback worker. |
| `RUNTIME_REMOTE_CONNECT_TIMEOUT_MS`, `..._READ_TIMEOUT_MS`, `..._COMMAND_TIMEOUT_MS`, `..._POLL_INTERVAL_MS` | Optional timing overrides. |

`@ezu/server` refuses to start with `RUNTIME_PROVIDER=remote` unless billing
(and therefore authentication) is enabled: an anonymous request must never
reach a real sandbox.

## Testing

This package's tests run against `src/test-support/fake-worker-server.ts`,
an in-memory HTTP server that implements the contract above just well
enough to exercise this adapter's request shapes, polling, and error
handling. **It has no container isolation, no persistence, and no security
properties of its own** — it must never be run as, or mistaken for, a real
sandbox. This repository does not include a container orchestrator or a
production worker implementation; both are deployment-specific and out of
scope here.
