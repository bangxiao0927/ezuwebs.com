export class WorkerConfigError extends Error {}

export interface WorkerLimitsConfig {
  maxRuntimes: number;
  memoryBytes: number;
  cpus: number;
  pidsLimit: number;
  workspaceMaxFileBytes: number;
  workspaceMaxFileCount: number;
  workspaceMaxTotalBytes: number;
  commandMaxOutputBytes: number;
  commandMaxTimeoutMs: number;
  runtimeTtlMs: number;
}

export interface WorkerConfig {
  host: string;
  port: number;
  apiToken: string;
  root: string;
  publicPreviewBaseUrl: string;
  allowInsecureLoopback: boolean;
  allowedImages: string[];
  dockerBin: string;
  requireRootless: boolean;
  limits: WorkerLimitsConfig;
}

const minTokenLength = 32;
const defaultPort = 4180;
const defaultHost = "127.0.0.1";

const defaultLimits: WorkerLimitsConfig = {
  maxRuntimes: 50,
  memoryBytes: 512 * 1024 * 1024,
  cpus: 1,
  pidsLimit: 256,
  workspaceMaxFileBytes: 5 * 1024 * 1024,
  workspaceMaxFileCount: 5_000,
  workspaceMaxTotalBytes: 200 * 1024 * 1024,
  commandMaxOutputBytes: 5 * 1024 * 1024,
  commandMaxTimeoutMs: 10 * 60 * 1000,
  runtimeTtlMs: 60 * 60 * 1000,
};

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value.trim().length === 0) {
    throw new WorkerConfigError(`${key} must be set`);
  }
  return value;
}

function parsePositiveIntEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new WorkerConfigError(`${key} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

function validatePreviewBaseUrl(value: string, allowInsecureLoopback: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WorkerConfigError(`WORKER_PUBLIC_PREVIEW_BASE_URL must be a valid absolute URL, got: ${value}`);
  }

  const isHttps = parsed.protocol === "https:";
  const isAllowedLoopbackHttp =
    parsed.protocol === "http:" && allowInsecureLoopback && isLoopbackHost(parsed.hostname);

  if (!isHttps && !isAllowedLoopbackHttp) {
    throw new WorkerConfigError(
      "WORKER_PUBLIC_PREVIEW_BASE_URL must use https; http is only allowed for a loopback host with " +
        "WORKER_ALLOW_INSECURE_LOOPBACK=true (local development only)",
    );
  }

  return value;
}

/**
 * Loads and validates every setting the worker needs before it accepts a
 * single request. Fails closed: an invalid or missing setting throws rather
 * than falling back to an insecure default.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const apiToken = requireEnv(env, "WORKER_API_TOKEN");
  if (apiToken.length < minTokenLength) {
    throw new WorkerConfigError(`WORKER_API_TOKEN must be at least ${minTokenLength} characters of strong randomness`);
  }

  const allowInsecureLoopback = env.WORKER_ALLOW_INSECURE_LOOPBACK === "true";
  const publicPreviewBaseUrl = validatePreviewBaseUrl(
    requireEnv(env, "WORKER_PUBLIC_PREVIEW_BASE_URL"),
    allowInsecureLoopback,
  );

  const allowedImages = requireEnv(env, "WORKER_ALLOWED_IMAGES")
    .split(",")
    .map((image) => image.trim())
    .filter((image) => image.length > 0);
  if (allowedImages.length === 0) {
    throw new WorkerConfigError("WORKER_ALLOWED_IMAGES must list at least one allowed image");
  }

  const requireRootless = env.WORKER_REQUIRE_ROOTLESS === "false" ? false : true;

  return {
    host: env.WORKER_HOST ?? defaultHost,
    port: parsePositiveIntEnv(env, "PORT", defaultPort),
    apiToken,
    root: requireEnv(env, "WORKER_ROOT"),
    publicPreviewBaseUrl,
    allowInsecureLoopback,
    allowedImages,
    dockerBin: requireEnv(env, "WORKER_DOCKER_BIN"),
    requireRootless,
    limits: {
      maxRuntimes: parsePositiveIntEnv(env, "WORKER_LIMIT_MAX_RUNTIMES", defaultLimits.maxRuntimes),
      memoryBytes: parsePositiveIntEnv(env, "WORKER_LIMIT_MEMORY_BYTES", defaultLimits.memoryBytes),
      cpus: parsePositiveIntEnv(env, "WORKER_LIMIT_CPUS", defaultLimits.cpus),
      pidsLimit: parsePositiveIntEnv(env, "WORKER_LIMIT_PIDS", defaultLimits.pidsLimit),
      workspaceMaxFileBytes: parsePositiveIntEnv(
        env,
        "WORKER_LIMIT_WORKSPACE_MAX_FILE_BYTES",
        defaultLimits.workspaceMaxFileBytes,
      ),
      workspaceMaxFileCount: parsePositiveIntEnv(
        env,
        "WORKER_LIMIT_WORKSPACE_MAX_FILE_COUNT",
        defaultLimits.workspaceMaxFileCount,
      ),
      workspaceMaxTotalBytes: parsePositiveIntEnv(
        env,
        "WORKER_LIMIT_WORKSPACE_MAX_TOTAL_BYTES",
        defaultLimits.workspaceMaxTotalBytes,
      ),
      commandMaxOutputBytes: parsePositiveIntEnv(
        env,
        "WORKER_LIMIT_COMMAND_MAX_OUTPUT_BYTES",
        defaultLimits.commandMaxOutputBytes,
      ),
      commandMaxTimeoutMs: parsePositiveIntEnv(
        env,
        "WORKER_LIMIT_COMMAND_MAX_TIMEOUT_MS",
        defaultLimits.commandMaxTimeoutMs,
      ),
      runtimeTtlMs: parsePositiveIntEnv(env, "WORKER_LIMIT_RUNTIME_TTL_MS", defaultLimits.runtimeTtlMs),
    },
  };
}
