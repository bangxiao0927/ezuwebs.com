export interface OpenAIClientConfig {
  apiKey: string;
  baseUrl: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamOptions {
  model: string;
  temperature: number;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Abort the request from the caller side (e.g. user cancels the run). */
  signal?: AbortSignal;
  /** Fail the request if no completion arrives within this many ms. Set to 0 to disable. */
  timeoutMs?: number;
}

export interface ChatCompletionChunk {
  content: string;
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

// Default guard so a stalled upstream connection cannot hang a run forever.
const DEFAULT_TIMEOUT_MS = 60_000;

interface ParsedSseLine {
  chunk?: ChatCompletionChunk;
  done?: boolean;
}

// Parse a single SSE line into an optional chunk and/or a stream-terminating flag.
function parseSseLine(line: string): ParsedSseLine | undefined {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("data:")) return undefined;

  const data = trimmed.slice("data:".length).trim();
  if (data === "[DONE]") return { done: true };

  try {
    const parsed = JSON.parse(data);
    const choice = parsed.choices?.[0];
    if (!choice) return undefined;

    const content: string = choice.delta?.content ?? "";
    const finishReason = choice.finish_reason ?? null;
    // Emit whenever there is content or a terminal finish reason to report,
    // so callers can observe why the stream ended even on an empty final frame.
    if (content || finishReason) {
      return { chunk: { content, finishReason } };
    }
  } catch {
    // Skip malformed SSE lines.
  }

  return undefined;
}

function resolveChatEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");

  if (path.endsWith("/chat/completions")) {
    url.pathname = path;
  } else if (path.endsWith("/v1")) {
    url.pathname = `${path}/chat/completions`;
  } else {
    url.pathname = `${path}/v1/chat/completions`;
  }

  // Fragments are never sent in HTTP requests and usually indicate a typo.
  url.hash = "";
  return url.toString();
}

export function createOpenAIClient(config: OpenAIClientConfig) {
  const { apiKey, baseUrl } = config;
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const chatEndpoint = resolveChatEndpoint(normalizedBaseUrl);

  async function* streamChat(opts: StreamOptions): AsyncIterable<ChatCompletionChunk> {
    // Own controller so we can enforce a timeout and forward an external abort.
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer =
      timeoutMs > 0
        ? setTimeout(
            () => controller.abort(new Error(`OpenAI request timed out after ${timeoutMs}ms`)),
            timeoutMs,
          )
        : undefined;

    const forwardAbort = () => controller.abort(opts.signal?.reason);
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", forwardAbort, { once: true });
    }

    try {
      const response = await fetch(chatEndpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: opts.model,
          temperature: opts.temperature,
          messages: opts.messages,
          max_tokens: opts.maxTokens ?? 4096,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(
          `OpenAI API error (${response.status}): ${errorBody.slice(0, 500)}`,
        );
      }

      if (!response.body) {
        throw new Error("OpenAI API returned an empty response body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          // Keep the last potentially incomplete line in the buffer.
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const result = parseSseLine(line);
            if (!result) continue;
            if (result.done) return;
            if (result.chunk) yield result.chunk;
          }
        }

        const finalResult = parseSseLine(buffer);
        if (finalResult && !finalResult.done && finalResult.chunk) {
          yield finalResult.chunk;
        }
      } finally {
        reader.releaseLock();
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", forwardAbort);
    }
  }

  return { streamChat };
}
