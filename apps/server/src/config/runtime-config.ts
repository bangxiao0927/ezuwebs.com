import { type RemoteRuntimeConfigInput } from "@ezu/runtime-remote";

export class RuntimeConfigError extends Error {}

export interface RuntimeConfigEnv {
  RUNTIME_PROVIDER?: string;
  RUNTIME_REMOTE_BASE_URL?: string;
  RUNTIME_REMOTE_TOKEN?: string;
  RUNTIME_REMOTE_IMAGE?: string;
  RUNTIME_REMOTE_PROFILE?: string;
  RUNTIME_REMOTE_COMMAND_POLICY?: string;
  RUNTIME_REMOTE_PREVIEW_BASE_URL?: string;
  RUNTIME_REMOTE_ALLOW_INSECURE_LOOPBACK?: string;
  RUNTIME_REMOTE_CONNECT_TIMEOUT_MS?: string;
  RUNTIME_REMOTE_READ_TIMEOUT_MS?: string;
  RUNTIME_REMOTE_COMMAND_TIMEOUT_MS?: string;
  RUNTIME_REMOTE_POLL_INTERVAL_MS?: string;
}

/** The shared, per-deployment part of a remote runtime's config; sessionId and projectId are supplied per session. */
export type RemoteRuntimeSharedConfig = Omit<RemoteRuntimeConfigInput, "sessionId" | "projectId">;

export type RuntimeProviderConfig =
  | { provider: "browser" }
  | { provider: "remote"; remote: RemoteRuntimeSharedConfig };

const supportedCommandPolicies = ["network-deny"];

function requireEnv(env: RuntimeConfigEnv, key: keyof RuntimeConfigEnv): string {
  const value = env[key];
  if (!value || value.trim().length === 0) {
    throw new RuntimeConfigError(`RUNTIME_PROVIDER=remote requires ${key} to be set`);
  }
  return value;
}

function parsePositiveIntEnv(env: RuntimeConfigEnv, key: keyof RuntimeConfigEnv): number | undefined {
  const raw = env[key];
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RuntimeConfigError(`${key} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

/**
 * Resolves which RuntimeAdapter provider the server should use, and, for the
 * remote provider, the shared worker config every session's adapter is
 * built from. Requires billing/auth to be enabled for the remote provider:
 * a real sandbox must never be reachable by an anonymous request.
 */
export function resolveRuntimeProviderConfig(
  env: RuntimeConfigEnv,
  options: { billingEnabled: boolean },
): RuntimeProviderConfig {
  const provider = env.RUNTIME_PROVIDER ?? "browser";

  if (provider === "browser") {
    return { provider: "browser" };
  }

  if (provider !== "remote") {
    throw new RuntimeConfigError(`Unknown RUNTIME_PROVIDER: ${provider} (expected "browser" or "remote")`);
  }

  if (!options.billingEnabled) {
    throw new RuntimeConfigError(
      "RUNTIME_PROVIDER=remote requires billing/auth to be enabled: an anonymous request must never reach a real sandbox",
    );
  }

  const commandPolicy = requireEnv(env, "RUNTIME_REMOTE_COMMAND_POLICY");
  if (!supportedCommandPolicies.includes(commandPolicy)) {
    throw new RuntimeConfigError(
      `RUNTIME_REMOTE_COMMAND_POLICY must be one of ${supportedCommandPolicies.join(", ")}, got: ${commandPolicy}`,
    );
  }

  const connectTimeoutMs = parsePositiveIntEnv(env, "RUNTIME_REMOTE_CONNECT_TIMEOUT_MS");
  const readTimeoutMs = parsePositiveIntEnv(env, "RUNTIME_REMOTE_READ_TIMEOUT_MS");
  const commandTimeoutMs = parsePositiveIntEnv(env, "RUNTIME_REMOTE_COMMAND_TIMEOUT_MS");
  const pollIntervalMs = parsePositiveIntEnv(env, "RUNTIME_REMOTE_POLL_INTERVAL_MS");

  return {
    provider: "remote",
    remote: {
      baseUrl: requireEnv(env, "RUNTIME_REMOTE_BASE_URL"),
      apiToken: requireEnv(env, "RUNTIME_REMOTE_TOKEN"),
      image: requireEnv(env, "RUNTIME_REMOTE_IMAGE"),
      profile: env.RUNTIME_REMOTE_PROFILE ?? "default",
      previewBaseUrl: requireEnv(env, "RUNTIME_REMOTE_PREVIEW_BASE_URL"),
      networkEgressDeny: true,
      allowInsecureLoopback: env.RUNTIME_REMOTE_ALLOW_INSECURE_LOOPBACK === "true",
      ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
      ...(readTimeoutMs === undefined ? {} : { readTimeoutMs }),
      ...(commandTimeoutMs === undefined ? {} : { commandTimeoutMs }),
      ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    },
  };
}
