import { z } from "zod";

export const planStepStatusSchema = z.enum(["pending", "in_progress", "completed", "blocked"]);
export type PlanStepStatus = z.infer<typeof planStepStatusSchema>;

export const actionLifecycleStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);
export type ActionLifecycleStatus = z.infer<typeof actionLifecycleStatusSchema>;

export const conversationRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export type ConversationRole = z.infer<typeof conversationRoleSchema>;

export const conversationMessageSchema = z.object({
  id: z.string(),
  role: conversationRoleSchema,
  content: z.string(),
  timestamp: z.string(),
  metadata: z.record(z.unknown()).optional(),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const planStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: planStepStatusSchema,
  requiresApproval: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});
export type PlanStep = z.infer<typeof planStepSchema>;

const choiceOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

export const fileWriteActionSchema = z.object({
  type: z.literal("file.write"),
  path: z.string(),
  content: z.string(),
});

export const filePatchActionSchema = z.object({
  type: z.literal("file.patch"),
  path: z.string(),
  patch: z.string(),
});

export const commandRunActionSchema = z.object({
  type: z.literal("command.run"),
  command: z.string(),
  cwd: z.string().optional(),
});

export const askChoiceActionSchema = z.object({
  type: z.literal("interaction.choice"),
  question: z.string(),
  options: z.array(choiceOptionSchema),
});

export const askConfirmActionSchema = z.object({
  type: z.literal("interaction.confirm"),
  title: z.string(),
  summary: z.string(),
});

export const openPreviewActionSchema = z.object({
  type: z.literal("preview.open"),
  port: z.number().int().positive().optional(),
});

export const agentActionSchema = z.discriminatedUnion("type", [
  fileWriteActionSchema,
  filePatchActionSchema,
  commandRunActionSchema,
  askChoiceActionSchema,
  askConfirmActionSchema,
  openPreviewActionSchema,
]);
export type AgentAction = z.infer<typeof agentActionSchema>;

export const actionStateSchema = z.object({
  id: z.string(),
  source: z.enum(["planner", "coder", "reviewer", "system"]),
  action: agentActionSchema,
  status: actionLifecycleStatusSchema,
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ActionState = z.infer<typeof actionStateSchema>;

export const pendingInteractionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    id: z.string(),
    question: z.string(),
    options: z.array(choiceOptionSchema),
  }),
  z.object({
    type: z.literal("confirm"),
    id: z.string(),
    title: z.string(),
    summary: z.string(),
  }),
  z.object({
    type: z.literal("input"),
    id: z.string(),
    label: z.string(),
    placeholder: z.string().optional(),
  }),
]);
export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;

export const runtimePortSchema = z.object({
  port: z.number().int().positive(),
  url: z.string(),
  status: z.enum(["open", "close"]),
  description: z.string().optional(),
});
export type RuntimePort = z.infer<typeof runtimePortSchema>;

export const runtimeSnapshotSchema = z.object({
  files: z.array(z.string()),
  openPorts: z.array(runtimePortSchema),
  activeCommands: z.array(z.string()),
});
export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>;

export const sessionStateSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  messages: z.array(conversationMessageSchema),
  plan: z.array(planStepSchema),
  actions: z.array(actionStateSchema),
  pendingInteraction: pendingInteractionSchema.optional(),
  runtime: runtimeSnapshotSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SessionState = z.infer<typeof sessionStateSchema>;

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message.delta"),
    messageId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("message.completed"),
    messageId: z.string(),
  }),
  z.object({
    type: z.literal("plan.updated"),
    plan: z.array(planStepSchema),
  }),
  z.object({
    type: z.literal("action.created"),
    action: actionStateSchema,
  }),
  z.object({
    type: z.literal("action.updated"),
    action: actionStateSchema,
  }),
  z.object({
    type: z.literal("command.output"),
    actionId: z.string(),
    chunk: z.string(),
  }),
  z.object({
    type: z.literal("file.changed"),
    path: z.string(),
  }),
  z.object({
    type: z.literal("preview.ready"),
    url: z.string(),
    port: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("interaction.required"),
    interaction: pendingInteractionSchema,
  }),
  z.object({
    type: z.literal("interaction.resolved"),
    interactionId: z.string(),
    status: z.enum(["approved", "rejected"]),
    title: z.string(),
    summary: z.string(),
    rejectionReason: z.string().optional(),
    followUpStrategy: z.enum(["revise", "replace_structure"]).optional(),
  }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

export function parseAgentEvent(input: unknown): AgentEvent {
  return agentEventSchema.parse(input);
}
