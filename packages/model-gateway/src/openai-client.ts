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
}

export interface ChatCompletionChunk {
  content: string;
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export function createOpenAIClient(config: OpenAIClientConfig) {
  const { apiKey, baseUrl } = config;
  const chatEndpoint = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;

  async function* streamChat(opts: StreamOptions): AsyncIterable<ChatCompletionChunk> {
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
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last potentially incomplete line in the buffer.
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;

          const data = trimmed.slice("data:".length).trim();
          if (data === "[DONE]") return;

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;
            if (delta?.content) {
              yield { content: delta.content, finishReason: choice.finish_reason ?? null };
            }
          } catch {
            // Skip malformed SSE lines.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  return { streamChat };
}
