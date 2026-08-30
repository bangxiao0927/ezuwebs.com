import { type RemoteRuntimeConfig } from "./config.js";
import {
  RemoteRuntimeConnectTimeoutError,
  RemoteRuntimeError,
  RemoteRuntimeHttpError,
  RemoteRuntimeProtocolError,
  RemoteRuntimeRedirectError,
  RemoteRuntimeReadTimeoutError,
  RemoteRuntimeResponseTooLargeError,
} from "./errors.js";

export interface HttpClientOptions {
  fetchImpl?: typeof fetch;
}

export interface RemoteRuntimeRequestInit {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Aborts the request early, independent of the connect/read timeouts (e.g. so a caller can cancel an in-flight poll). */
  signal?: AbortSignal;
}

/** Reads a fetch Response body up to `maxBytes`, throwing rather than buffering an unbounded worker response. */
async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RemoteRuntimeResponseTooLargeError(
        `Runtime worker response exceeded the ${maxBytes} byte limit`,
      );
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/**
 * Sends one request to the runtime worker and returns its parsed JSON body.
 * The connect timeout bounds the time until response headers arrive; the
 * read timeout separately bounds the time spent then reading the body.
 * `init.signal`, if given, aborts the request independent of both timeouts.
 * Redirects are never followed: a 3xx response is a typed error. Never
 * includes the Authorization header, the request body, or the worker's
 * response body in a thrown error.
 */
export async function requestRuntimeWorker(
  config: RemoteRuntimeConfig,
  path: string,
  init: RemoteRuntimeRequestInit,
  options: HttpClientOptions = {},
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${config.baseUrl.replace(/\/+$/, "")}${path}`;
  const controller = new AbortController();
  let timedOutPhase: "connect" | "read" | undefined;

  const externalSignal = init.signal;
  const onExternalAbort = (): void => {
    controller.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort);
    }
  }

  try {
    const connectTimer = setTimeout(() => {
      timedOutPhase = "connect";
      controller.abort();
    }, config.connectTimeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (error) {
      if (timedOutPhase === "connect") {
        throw new RemoteRuntimeConnectTimeoutError(
          `Timed out connecting to the runtime worker after ${config.connectTimeoutMs}ms`,
        );
      }
      throw new RemoteRuntimeError(
        `Failed to reach the runtime worker: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(connectTimer);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new RemoteRuntimeRedirectError(
        response.status,
        `Runtime worker responded with a redirect (${response.status}), which this adapter never follows`,
      );
    }

    const readTimer = setTimeout(() => {
      timedOutPhase = "read";
      controller.abort();
    }, config.readTimeoutMs);

    let bodyText: string;
    try {
      bodyText = await readBodyWithLimit(response, config.limits.maxResponseBytes);
    } catch (error) {
      if (timedOutPhase === "read") {
        throw new RemoteRuntimeReadTimeoutError(
          `Timed out reading the runtime worker's response after ${config.readTimeoutMs}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(readTimer);
    }

    if (!response.ok) {
      throw new RemoteRuntimeHttpError(
        response.status,
        `Runtime worker responded with an error status (${response.status})`,
      );
    }

    if (bodyText.length === 0) {
      return undefined;
    }

    try {
      return JSON.parse(bodyText) as unknown;
    } catch (cause) {
      throw new RemoteRuntimeProtocolError("Runtime worker returned a response that was not valid JSON", {
        cause,
      });
    }
  } finally {
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}
