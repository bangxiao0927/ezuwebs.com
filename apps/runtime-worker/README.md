# @ezu/runtime-worker

A production sandbox worker implementing the `@ezu/runtime-remote` package's
worker contract (see `packages/runtime-remote/README.md`). It owns every
docker interaction for a deployment: `@ezu/server` never runs Docker or any
other child process itself, it only ever speaks HTTP to this worker.

## What this is not

- Not a microVM sandbox. It runs plain Linux containers via the `DockerEngine`
  port. The port is designed so a future microVM-backed engine (Firecracker,
  gVisor, etc.) could implement the same interface, but no such engine exists
  in this repository.
- Not a general-purpose reverse proxy. `GET /p/:token/*` only ever serves the
  requesting runtime's own workspace `index.html` (`mode: "static"`); it never
  forwards a request to an arbitrary host or port.
- Not safe to expose to the public internet directly. It must sit behind, and
  be reachable only from, the trusted `@ezu/server` process (or an operator
  network), never from an anonymous client.

## Configuration

| Env var | Purpose |
| --- | --- |
| `WORKER_HOST` | Bind address. Defaults to `127.0.0.1`. |
| `PORT` | Listen port. Defaults to `4180`. |
| `WORKER_API_TOKEN` | Bearer token every `/internal/runtime/v1/*` request must present. Must be at least 32 characters of strong randomness; there is no default. |
| `WORKER_ROOT` | Directory for the registry's persisted JSON and `docker cp` scratch files. |
| `WORKER_PUBLIC_PREVIEW_BASE_URL` | Origin every issued preview URL is built under. Must be `https://` unless `WORKER_ALLOW_INSECURE_LOOPBACK=true` and the host is loopback (local dev only). |
| `WORKER_ALLOWED_IMAGES` | Comma-separated allowlist of sandbox images `createRuntime` may use. |
| `WORKER_DOCKER_BIN` | Absolute path to the `docker` binary. Never resolved from `PATH` or a request. |
| `WORKER_REQUIRE_ROOTLESS` | Defaults to `true`. The worker refuses to start unless `docker info` reports `name=rootless`. Set to `false` only for an explicit, isolated local-dev override; never in production. |
| `WORKER_ALLOW_INSECURE_LOOPBACK` | `true` only for local development against a loopback preview URL. |
| `WORKER_LIMIT_*` | Overrides for the global resource/quota defaults in `src/config.ts` (memory, cpus, pids, workspace file/byte limits, command output/timeout, runtime TTL). |

## Architecture

- `docker/engine.ts` defines the `DockerEngine` port every domain service
  depends on. `docker/docker-cli-engine.ts` is the only production
  implementation: it calls `spawn(dockerBin, args, { shell: false })`
  exclusively, with `dockerBin` fixed from startup config. It never builds a
  shell string.
- `docker/container-args.ts` builds the `docker create` argv for a runtime
  container: fixed non-root uid, `--network none`, `--read-only`,
  `--cap-drop ALL`, `--security-opt no-new-privileges`, resource limits, and
  tmpfs-only `/tmp` and `/workspace` (noexec by default; a profile can opt
  `/workspace` into exec, but never into anything else).
- `registry/runtime-registry.ts` persists runtime metadata as one
  atomically-written JSON file and enforces at most one active runtime per
  session (idempotent `create()`).
- `workspace/workspace-service.ts` re-validates every path server-side,
  independent of any client validation, and enforces file/count/byte quotas
  and optimistic-concurrency (`expectedVersion`, a sha256 of the file's
  content) before any write reaches the engine.
- `commands/command-policy.ts` is the only way an argv is allowed to run: a
  named, server-defined allowlist of executables and (where relevant)
  subcommands. There is no free-form shell entry point anywhere in this
  service.
- `preview/preview-service.ts` issues opaque tokens mapped to a runtime; it
  never accepts or forwards a caller-supplied host or port. The only
  implemented mode is `static`: `GET /p/:token/*` serves the runtime
  workspace's `index.html` directly.
- `ttl/sweeper.ts` stops and deletes runtimes past their `expiresAt`, and
  reconciles the registry against whatever the engine's own managed-container
  labels report, so a worker restart or crash cannot orphan a container this
  worker no longer knows about (and never touches a container without this
  worker's own `managed-by` label). It depends only on `RuntimeService`, never
  the registry or engine directly, so every deletion or failure it triggers
  goes through the same cleanup as an HTTP-triggered one (preview tokens,
  event log, command state, workspace usage).
- `registry/runtime-registry.ts` also enforces `WORKER_LIMIT_MAX_RUNTIMES`: a
  `create()` beyond that cap throws `RuntimeCapacityError`, surfaced over
  HTTP as `429`. The check and the record insertion happen with no `await`
  between them, so concurrent `create()` calls within one process can never
  together exceed the cap.

## Threat model

- **Untrusted input**: every request body, path, argv, and port is untrusted,
  even though it nominally comes from `@ezu/server`'s already-validated
  `@ezu/runtime-remote` client. This worker re-validates independently and
  fails closed on anything unexpected.
- **Docker socket exposure**: this worker is the only process with docker
  access in the deployment. It must run against a **rootless** docker daemon
  (enforced at startup) so that even a full compromise of this process's
  docker access does not grant host root. `docker-compose.runtime.yml` shows
  the worker talking to a separate `docker:*-dind-rootless` sibling; the
  socket/TCP endpoint between them must never be reachable from outside that
  private network.
- **Sandbox escape**: runtime containers get no network, a read-only root
  filesystem, all capabilities dropped, `no-new-privileges`, a fixed non-root
  uid, and tmpfs-only scratch space. `Dockerfile.runtime-image` is a minimal,
  non-root base image for those containers; it carries no docker CLI or
  network tooling of its own, though the actual enforcement is the container
  flags, not what the image happens to ship.
- **Path/command injection**: `workspace/path-validation.ts` and
  `commands/command-policy.ts` are the last line of defense against a
  traversal or shell-injection attempt reaching a real filesystem path or
  process argv. Symlink escapes are not separately detected on the host,
  because the worker never creates a symlink itself and every path a client
  can address is a plain relative path with no `..` segment; a symlink could
  only appear inside a runtime's own tmpfs workspace, which is destroyed with
  the container.
- **SSRF via preview**: `/p/:token/*` never takes a caller-supplied host or
  port; a token only ever resolves to a runtime this worker itself created,
  and the response is always this worker serving a file from that runtime's
  workspace, never a proxied request elsewhere.
- **Denial of service**: request bodies, file sizes, file counts, and command
  output are all capped; commands are killed on timeout; runtimes are capped
  by TTL and (via `WORKER_LIMIT_MAX_RUNTIMES`, enforced by the deployment
  operator's docker daemon resource limits) by count.
- **Killing a runaway command**: a command's `timeoutMs` and `maxOutputBytes`
  are validated (finite, positive) and clamped to `WORKER_LIMIT_COMMAND_MAX_*`
  before use. On timeout, explicit cancel, or hitting the output limit, the
  worker does not just kill the `docker exec` client process (which would
  leave the exec'd process running inside the container); it terminates the
  whole container via `DockerEngine.terminateContainer` and marks the owning
  runtime `failed`. A client must create a new runtime afterwards.
- **Cross-runtime command access**: a command is bound to the containerId it
  was created against. Looking it up (status, events, cancel) through a
  different runtime's id is treated as not found, even if the command id
  itself is guessed or leaked.

## Known limitations

- Workspace byte/file-count quotas are tracked in this process's memory, per
  container, and are not recovered across a worker restart. A restart runs
  orphan reconciliation on containers, but a workspace quota resets to empty
  bookkeeping against whatever the container still holds; this is judged
  acceptable because runtimes are short-lived and TTL-bounded, not because it
  is unimportant.
- Preview is `static`-only: it cannot preview a running dev server on a
  container port, because runtime containers get `--network none` by
  default. A future engine or profile that opts a runtime into a private,
  worker-controlled network could add a real reverse-proxy preview mode; none
  exists today, and this worker will not fake one.
- `DockerEngine.execCommand`'s `oomKilled` is always reported `false` by
  `DockerCliEngine`: detecting an OOM kill reliably requires inspecting the
  container's cgroup after exit, which is not implemented yet. A caller must
  not rely on `oomKilled` being accurate outside `FakeDockerEngine`, which
  never sets it either.

## Testing

`src/docker/container-args.test.ts` and `src/docker/rootless-check.test.ts`
are pure unit tests that never spawn a real `docker` process. Every other
test in this package runs against `docker/test-support/fake-docker-engine.ts`,
an in-memory `DockerEngine` with no container isolation and no security
properties of its own; it exists only to exercise this worker's HTTP
contract, registry, and policy logic, the same way
`packages/runtime-remote/src/test-support/fake-worker-server.ts` exercises
the client side. Neither fake should ever be run as, or mistaken for, a
production sandbox.

`src/docker/docker-cli-engine.test.ts` is the one exception: it spawns a
real, separate process as `dockerBin`, scripted by
`docker/test-support/fake-docker-cli.ts`, to exercise `DockerCliEngine`'s own
argv-building and host-filesystem-safety logic (e.g. that `docker cp` is
never trusted to have avoided a container-supplied symlink) without a real
docker daemon.
