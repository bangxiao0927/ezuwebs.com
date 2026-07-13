import { type AgentEvent } from "@ezu/protocol";
import { createRealModelGateway } from "./real-gateway.js";

export type ModelTask = "planning" | "coding" | "review" | "summary" | "title";

export interface ModelRoute {
  model: string;
  temperature: number;
}

export interface ModelProfile {
  planning: ModelRoute;
  coding: ModelRoute;
  review: ModelRoute;
  summary: ModelRoute;
  title: ModelRoute;
}

export interface PlannerInput {
  prompt: string;
}

export interface CoderInput {
  prompt: string;
}

export interface SummaryInput {
  content: string;
}

export interface ModelGateway {
  getProfile(): ModelProfile;
  streamPlan(input: PlannerInput): AsyncIterable<AgentEvent>;
  streamCode(input: CoderInput): AsyncIterable<AgentEvent>;
  summarizeProject(input: SummaryInput): Promise<string>;
}

export const defaultModelProfile: ModelProfile = {
  planning: { model: "gpt-5.4", temperature: 0.2 },
  coding: { model: "gpt-5.3-codex", temperature: 0.1 },
  review: { model: "gpt-5.4", temperature: 0.1 },
  summary: { model: "gpt-5-mini", temperature: 0.3 },
  title: { model: "gpt-5-mini", temperature: 0.4 },
};

export function createModelGateway(profile: ModelProfile = defaultModelProfile): ModelGateway {
  return {
    getProfile() {
      return profile;
    },
    async *streamPlan(input) {
      const messageId = crypto.randomUUID();

      yield {
        type: "message.delta",
        messageId,
        text: "I am outlining the first-pass workspace initialization flow (3 steps).",
      };
      yield {
        type: "message.delta",
        messageId,
        text: ` Request: ${input.prompt}`,
      };
      yield {
        type: "plan.updated",
        plan: [
          {
            id: crypto.randomUUID(),
            title: "Define the app and package boundaries",
            description: "Pin the web, agent, protocol, runtime, and UI ownership.",
            status: "completed",
          },
          {
            id: crypto.randomUUID(),
            title: "Scaffold a first file-level action",
            description: "Write a bootstrap file through the runtime adapter.",
            status: "in_progress",
          },
          {
            id: crypto.randomUUID(),
            title: "Expose the resulting state to the web workbench",
            description: "Reduce events into chat, plan, files, timeline, and preview state.",
            status: "pending",
            requiresApproval: false,
          },
        ],
      };
      yield {
        type: "interaction.required",
        interaction: {
          type: "confirm",
          id: crypto.randomUUID(),
          title: "Proceed with the initial scaffold action",
          summary: "The demo flow will write a generated bootstrap file and publish a preview event.",
        },
      };
      yield {
        type: "message.completed",
        messageId,
      };
    },
    async *streamCode(input) {
      yield {
        type: "message.delta",
        messageId: "coder",
        text: input.prompt,
      };
      yield {
        type: "message.completed",
        messageId: "coder",
      };
    },
    async summarizeProject(input) {
      return input.content.slice(0, 140);
    },
  };
}

// Re-export the real (OpenAI-backed) gateway and its dependencies.
export { createRealModelGateway, type RealModelGatewayOptions } from "./real-gateway.js";
export { createOpenAIClient, type OpenAIClientConfig, type ChatMessage, type StreamOptions, type ChatCompletionChunk } from "./openai-client.js";

/**
 * Resolve a ModelGateway based on environment configuration.
 *
 * - If OPENAI_API_KEY is set, returns a real LLM-backed gateway.
 * - Otherwise falls back to the stub demo gateway.
 *
 * The real gateway reads these environment variables:
 *   OPENAI_API_KEY     (required) — API key for the OpenAI-compatible endpoint.
 *   OPENAI_BASE_URL    (optional) — defaults to "https://api.openai.com".
 *   OPENAI_PLAN_MODEL  (optional) — model for planning tasks (default: gpt-4o).
 *   OPENAI_CODE_MODEL  (optional) — model for coding tasks (default: gpt-4o).
 */
export function resolveModelGateway(env: typeof process.env = process.env): ModelGateway {
  const apiKey = env.OPENAI_API_KEY?.trim();

  if (apiKey) {
    return createRealModelGateway({
      clientConfig: {
        apiKey,
        baseUrl: env.OPENAI_BASE_URL?.trim() || "https://api.openai.com",
      },
      profile: {
        planning: { model: env.OPENAI_PLAN_MODEL?.trim() || "gpt-4o", temperature: 0.2 },
        coding: { model: env.OPENAI_CODE_MODEL?.trim() || "gpt-4o", temperature: 0.1 },
        review: { model: env.OPENAI_PLAN_MODEL?.trim() || "gpt-4o", temperature: 0.1 },
        summary: { model: "gpt-4o-mini", temperature: 0.3 },
        title: { model: "gpt-4o-mini", temperature: 0.4 },
      },
    });
  }

  return createModelGateway();
}
