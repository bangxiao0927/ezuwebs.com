import { randomBytes } from "node:crypto";

export class PreviewPortNotAllowedError extends Error {}

export interface PreviewServiceOptions {
  publicBaseUrl: string;
  allowedPorts: number[];
  ttlMs: number;
}

export interface IssuedPreview {
  token: string;
  port: number;
  url: string;
  status: "open";
}

export interface ResolvedPreview {
  runtimeId: string;
  port: number;
  mode: "static";
}

interface PreviewRecord extends ResolvedPreview {
  expiresAt: number;
}

/**
 * Issues opaque preview tokens that map to a runtime, never to a
 * caller-supplied host or port. `resolve()` is the only way to turn a
 * token back into a runtime, and it fails closed once a token expires or
 * is disposed. Only "static" mode is implemented: the worker serves the
 * runtime workspace's index.html directly, with no reverse-proxy path to
 * an arbitrary host or port.
 */
export class PreviewService {
  private readonly tokens = new Map<string, PreviewRecord>();

  constructor(private readonly options: PreviewServiceOptions) {}

  issue(runtimeId: string, requestedPort?: number): IssuedPreview {
    const port = requestedPort ?? this.options.allowedPorts[0]!;
    if (!this.options.allowedPorts.includes(port)) {
      throw new PreviewPortNotAllowedError(
        `port ${port} is not in the configured preview allowlist (${this.options.allowedPorts.join(", ")})`,
      );
    }
    const token = randomBytes(24).toString("base64url");
    this.tokens.set(token, { runtimeId, port, mode: "static", expiresAt: Date.now() + this.options.ttlMs });
    return {
      token,
      port,
      url: `${this.options.publicBaseUrl.replace(/\/+$/, "")}/p/${token}/`,
      status: "open",
    };
  }

  resolve(token: string): ResolvedPreview | undefined {
    const record = this.tokens.get(token);
    if (!record) {
      return undefined;
    }
    if (record.expiresAt <= Date.now()) {
      this.tokens.delete(token);
      return undefined;
    }
    return { runtimeId: record.runtimeId, port: record.port, mode: record.mode };
  }

  disposeForRuntime(runtimeId: string): void {
    for (const [token, record] of this.tokens) {
      if (record.runtimeId === runtimeId) {
        this.tokens.delete(token);
      }
    }
  }
}
