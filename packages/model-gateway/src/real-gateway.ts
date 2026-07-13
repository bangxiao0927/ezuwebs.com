import { type AgentEvent } from "@ezu/protocol";

import { createOpenAIClient, type OpenAIClientConfig } from "./openai-client.js";
import {
  CODER_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  SUMMARIZER_SYSTEM_PROMPT,
} from "./prompts.js";

import {
  type CoderInput,
  type ModelGateway,
  type ModelProfile,
  type PlannerInput,
  type SummaryInput,
} from "./index.js";

export interface RealModelGatewayOptions {
  clientConfig: OpenAIClientConfig;
  profile?: ModelProfile;
}

function extractJsonLine(text: string): unknown | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not a JSON line; keep searching backward.
    }
  }
  return undefined;
}

export function createRealModelGateway(options: RealModelGatewayOptions): ModelGateway {
  const client = createOpenAIClient(options.clientConfig);
  const {
    planning = { model: "gpt-4o", temperature: 0.2 },
    coding = { model: "gpt-4o", temperature: 0.1 },
    review = { model: "gpt-4o", temperature: 0.1 },
    summary = { model: "gpt-4o-mini", temperature: 0.3 },
    title = { model: "gpt-4o-mini", temperature: 0.4 },
  } = options.profile ?? {};

  return {
    getProfile() {
      return { planning, coding, review, summary, title };
    },

    async *streamPlan(input: PlannerInput): AsyncIterable<AgentEvent> {
      const messageId = crypto.randomUUID();
      let fullText = "";

      // Stream the LLM response as message.delta events.
      const chunks = client.streamChat({
        model: planning.model,
        temperature: planning.temperature,
        messages: [
          { role: "system", content: PLANNER_SYSTEM_PROMPT },
          { role: "user", content: input.prompt },
        ],
      });

      for await (const chunk of chunks) {
        fullText += chunk.content;
        yield { type: "message.delta", messageId, text: chunk.content };
      }

      // Parse the structured JSON from the response.
      const parsed = extractJsonLine(fullText) as Record<string, unknown> | undefined;

      if (parsed?.plan && Array.isArray(parsed.plan)) {
        yield {
          type: "plan.updated",
          plan: parsed.plan.map((step: Record<string, unknown>) => ({
            id: String(step.id ?? crypto.randomUUID()),
            title: String(step.title ?? "Untitled step"),
            ...(step.description ? { description: String(step.description) } : {}),
            status: (["pending", "in_progress", "completed", "blocked"].includes(String(step.status))
              ? String(step.status)
              : "pending") as "pending" | "in_progress" | "completed" | "blocked",
            ...(step.requiresApproval !== undefined
              ? { requiresApproval: Boolean(step.requiresApproval) }
              : {}),
            ...(step.tags && Array.isArray(step.tags) ? { tags: step.tags.map(String) } : {}),
          })),
        };
      }

      if (parsed?.interaction && typeof parsed.interaction === "object") {
        const ix = parsed.interaction as Record<string, unknown>;
        if (ix.type === "confirm") {
          yield {
            type: "interaction.required",
            interaction: {
              type: "confirm",
              id: crypto.randomUUID(),
              title: String(ix.title ?? "Confirm"),
              summary: String(ix.summary ?? ""),
            },
          };
        } else if (ix.type === "choice") {
          yield {
            type: "interaction.required",
            interaction: {
              type: "choice",
              id: crypto.randomUUID(),
              question: String(ix.question ?? "Choose an option"),
              options: Array.isArray(ix.options)
                ? ix.options.map((opt: Record<string, unknown>) => ({
                    id: String(opt.id ?? crypto.randomUUID()),
                    label: String(opt.label ?? "Option"),
                    ...(opt.description ? { description: String(opt.description) } : {}),
                  }))
                : [],
            },
          };
        }
      }

      yield { type: "message.completed", messageId };
    },

    async *streamCode(input: CoderInput): AsyncIterable<AgentEvent> {
      const messageId = crypto.randomUUID();
      let fullText = "";

      const chunks = client.streamChat({
        model: coding.model,
        temperature: coding.temperature,
        messages: [
          { role: "system", content: CODER_SYSTEM_PROMPT },
          { role: "user", content: input.prompt },
        ],
      });

      for await (const chunk of chunks) {
        fullText += chunk.content;
        yield { type: "message.delta", messageId, text: chunk.content };
      }

      const parsed = extractJsonLine(fullText) as Record<string, unknown> | undefined;

      if (parsed?.actions && Array.isArray(parsed.actions)) {
        for (const act of parsed.actions as Record<string, unknown>[]) {
          const timestamp = new Date().toISOString();
          const actionType = String(act.type ?? "");

          if (actionType === "file.write") {
            yield {
              type: "action.created",
              action: {
                id: crypto.randomUUID(),
                source: "coder",
                action: {
                  type: "file.write",
                  path: String(act.path ?? ""),
                  content: String(act.content ?? ""),
                },
                status: "pending",
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            };
          } else if (actionType === "file.patch") {
            yield {
              type: "action.created",
              action: {
                id: crypto.randomUUID(),
                source: "coder",
                action: {
                  type: "file.patch",
                  path: String(act.path ?? ""),
                  patch: String(act.patch ?? ""),
                },
                status: "pending",
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            };
          } else if (actionType === "command.run") {
            yield {
              type: "action.created",
              action: {
                id: crypto.randomUUID(),
                source: "coder",
                action: {
                  type: "command.run",
                  command: String(act.command ?? ""),
                  ...(act.cwd ? { cwd: String(act.cwd) } : {}),
                },
                status: "pending",
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            };
          }
        }
      }

      yield { type: "message.completed", messageId };
    },

    async summarizeProject(input: SummaryInput): Promise<string> {
      // Non-streaming call for summarization.
      const chunks: string[] = [];
      for await (const chunk of client.streamChat({
        model: summary.model,
        temperature: summary.temperature,
        messages: [
          { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
          { role: "user", content: input.content },
        ],
        maxTokens: 256,
      })) {
        chunks.push(chunk.content);
      }

      const summaryText = chunks.join("").trim();
      return summaryText.slice(0, 200) || input.content.slice(0, 140);
    },
  };
}
