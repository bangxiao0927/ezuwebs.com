import { RemoteRuntimeConfigError } from "./errors.js";

export interface RemoteRuntimeLimits {
  /** Max bytes accepted for a single file's content on write/patch. */
  maxFileBytes?: number;
  /** Max number of files a listFiles/seed payload may contain. */
  maxFileCount?: number;
  /** Max total bytes across all files in a seed payload. */
  maxSeedBytes?: number;
  /** Max bytes of a single HTTP response body this adapter will read. */
  maxResponseBytes?: number;
  /** Max bytes of accumulated command output before it is truncated. */
  maxCommandOutputBytes?: number;
  /** Max number of argv entries runCommand's tokenizer will accept. */
  maxArgvCount?: number;
  /** Max total character length of the command string runCommand will tokenize. */
  maxCommandLength?: number;
}

export interface RemoteRuntimeConfigInput {
  baseUrl: string;
  apiToken: string;
  sessionId: string;
  projectId: string;
  image: string;
  profile: string;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  commandTimeoutMs?: number;
  pollIntervalMs?: number;
  limits?: RemoteRuntimeLimits;
  /** Whether the worker should deny outbound network egress from the sandbox. Defaults to true (deny). */
  networkEgressDeny?: boolean;
  /** Origin previews must match, if the deployment restricts preview URLs to one domain. */
  previewBaseUrl?: string;
  /** Allows an http:// baseUrl/previewBaseUrl, but only for 127.0.0.1 or localhost hosts (local dev only). */
  allowInsecureLoopback?: boolean;
}

export interface RemoteRuntimeConfig {
  baseUrl: string;
  apiToken: string;
  sessionId: string;
  projectId: string;
  image: string;
  profile: string;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  commandTimeoutMs: number;
  pollIntervalMs: number;
  limits: Required<RemoteRuntimeLimits>;
  networkEgressDeny: boolean;
  previewBaseUrl?: string;
  allowInsecureLoopback: boolean;
}

const defaultLimits: Required<RemoteRuntimeLimits> = {
  maxFileBytes: 5 * 1024 * 1024,
  maxFileCount: 5_000,
  maxSeedBytes: 50 * 1024 * 1024,
  maxResponseBytes: 10 * 1024 * 1024,
  maxCommandOutputBytes: 5 * 1024 * 1024,
  maxArgvCount: 64,
  maxCommandLength: 4_000,
};

const defaultConnectTimeoutMs = 10_000;
const defaultReadTimeoutMs = 30_000;
const defaultCommandTimeoutMs = 5 * 60 * 1000;
const defaultPollIntervalMs = 500;

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

/**
 * Validates and normalizes a URL used for either `baseUrl` or `previewBaseUrl`.
 * Both must be https, carry no credentials/query/hash, and may only use http
 * for an explicitly loopback host with `allowInsecureLoopback` set.
 */
function validateUrl(fieldName: string, value: string, allowInsecureLoopback: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RemoteRuntimeConfigError(`${fieldName} must be a valid absolute URL, got: ${value}`);
  }

  const isHttps = parsed.protocol === "https:";
  const isAllowedLoopbackHttp =
    parsed.protocol === "http:" && allowInsecureLoopback && isLoopbackHost(parsed.hostname);

  if (!isHttps && !isAllowedLoopbackHttp) {
    throw new RemoteRuntimeConfigError(
      `${fieldName} must use https (got ${parsed.protocol}//${parsed.hostname}); ` +
        `http is only allowed for 127.0.0.1/localhost with allowInsecureLoopback enabled`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new RemoteRuntimeConfigError(`${fieldName} must not carry credentials`);
  }
  if (parsed.search) {
    throw new RemoteRuntimeConfigError(`${fieldName} must not carry a query string`);
  }
  if (parsed.hash) {
    throw new RemoteRuntimeConfigError(`${fieldName} must not carry a hash fragment`);
  }

  return value;
}

function requireNonBlank(fieldName: string, value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RemoteRuntimeConfigError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function requirePositive(fieldName: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RemoteRuntimeConfigError(`${fieldName} must be a positive number, got: ${value}`);
  }
  return value;
}

/** The shared, per-deployment part of a {@link RemoteRuntimeConfigInput}; sessionId and projectId are supplied per session and validated separately by {@link validateRemoteRuntimeConfig}. */
export type RemoteRuntimeSharedConfigInput = Omit<RemoteRuntimeConfigInput, "sessionId" | "projectId">;

/** The validated, normalized form of a {@link RemoteRuntimeSharedConfigInput}. */
export type RemoteRuntimeSharedConfig = Omit<RemoteRuntimeConfig, "sessionId" | "projectId">;

/**
 * Validates and normalizes every part of a remote runtime config except
 * sessionId/projectId, so a deployment can fail fast on a bad baseUrl,
 * apiToken, image, profile, or timeout/limit setting before any session
 * ever tries to create a runtime.
 */
export function validateRemoteRuntimeSharedConfig(input: RemoteRuntimeSharedConfigInput): RemoteRuntimeSharedConfig {
  const allowInsecureLoopback = input.allowInsecureLoopback ?? false;

  const baseUrl = validateUrl("baseUrl", input.baseUrl, allowInsecureLoopback);
  const previewBaseUrl = input.previewBaseUrl
    ? validateUrl("previewBaseUrl", input.previewBaseUrl, allowInsecureLoopback)
    : undefined;

  return {
    baseUrl,
    apiToken: requireNonBlank("apiToken", input.apiToken),
    image: requireNonBlank("image", input.image),
    profile: requireNonBlank("profile", input.profile),
    connectTimeoutMs: requirePositive("connectTimeoutMs", input.connectTimeoutMs ?? defaultConnectTimeoutMs),
    readTimeoutMs: requirePositive("readTimeoutMs", input.readTimeoutMs ?? defaultReadTimeoutMs),
    commandTimeoutMs: requirePositive("commandTimeoutMs", input.commandTimeoutMs ?? defaultCommandTimeoutMs),
    pollIntervalMs: requirePositive("pollIntervalMs", input.pollIntervalMs ?? defaultPollIntervalMs),
    limits: { ...defaultLimits, ...input.limits },
    networkEgressDeny: input.networkEgressDeny ?? true,
    ...(previewBaseUrl ? { previewBaseUrl } : {}),
    allowInsecureLoopback,
  };
}

export function validateRemoteRuntimeConfig(input: RemoteRuntimeConfigInput): RemoteRuntimeConfig {
  const shared = validateRemoteRuntimeSharedConfig(input);
  return {
    ...shared,
    sessionId: requireNonBlank("sessionId", input.sessionId),
    projectId: requireNonBlank("projectId", input.projectId),
  };
}
