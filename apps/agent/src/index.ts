import {
  applyAgentEvent,
  collectEventStream,
  createExecutor,
  createSessionState,
  createSessionStore,
  createTimelineAction,
  type RuntimeAdapter,
} from "@ezu/core";
import { createModelGateway } from "@ezu/model-gateway";
import { type ActionState, type AgentEvent } from "@ezu/protocol";
import { createBrowserRuntimeStub } from "@ezu/runtime-browser";

import { createReplacementStructurePatch, normalizeReason } from "./replacement.js";

export interface WorkspaceFileEntry {
  path: string;
  content: string;
}

export interface AgentAppOptions {
  sessionId: string;
  projectId: string;
}

export interface BlockEditDemoOptions extends AgentAppOptions {
  blockId: string;
  targetPath: string;
  suggestedPrompt: string;
}

export interface ApprovedBlockEditExecutionOptions extends AgentAppOptions {
  action: ActionState;
  runtime: RuntimeAdapter;
  workspaceFiles?: WorkspaceFileEntry[];
}

export interface ApprovedBlockEditExecutionResult {
  events: AgentEvent[];
  workspaceFiles: WorkspaceFileEntry[];
}

export interface ReplacementBlockEditDemoOptions extends BlockEditDemoOptions {
  rejectedPatch: string;
  rejectionReason: string;
}

function applyEvent(session: ReturnType<typeof createSessionState>, events: AgentEvent[], event: AgentEvent) {
  events.push(event);
  return applyAgentEvent(session, event);
}

async function bridgeRuntimeEvents(input: {
  runtime: RuntimeAdapter;
  apply: (event: AgentEvent) => void;
}): Promise<() => void> {
  const stopFiles = await input.runtime.watchFiles((event) => {
    input.apply({
      type: "file.changed",
      path: event.path,
    });
  });

  const stopPorts = await input.runtime.watchPorts((event) => {
    if (event.status !== "open") {
      return;
    }

    input.apply({
      type: "preview.ready",
      url: event.url,
      port: event.port,
    });
  });

  return () => {
    stopFiles();
    stopPorts();
  };
}

export async function bootstrapBlockEditDemo(
  options: BlockEditDemoOptions,
): Promise<AgentEvent[]> {
  const sessionStore = createSessionStore();
  let session = createSessionState({
    id: options.sessionId,
    projectId: options.projectId,
  });
  const events: AgentEvent[] = [];

  sessionStore.upsert(session);

  const gateway = createModelGateway();
  const messageId = crypto.randomUUID();

  session = applyEvent(session, events, {
    type: "message.delta",
    messageId,
    text: `Planner is translating the ${options.blockId} block edit request into executable steps.`,
  });

  session = applyEvent(session, events, {
    type: "plan.updated",
    plan: [
      {
        id: crypto.randomUUID(),
        title: `Inspect the ${options.blockId} block`,
        description: `Use the suggested prompt to focus changes on ${options.targetPath}.`,
        status: "completed",
      },
      {
        id: crypto.randomUUID(),
        title: "Generate a block-scoped patch action",
        description: "Produce a safe file.patch demo action from the block editor request.",
        status: "completed",
        requiresApproval: true,
      },
      {
        id: crypto.randomUUID(),
        title: "Review and confirm the patch",
        description: "Flag the block-scoped patch for user confirmation before replaying it.",
        status: "in_progress",
        requiresApproval: true,
      },
      {
        id: crypto.randomUUID(),
        title: "Replay the resulting changes in the workbench",
        description: "Expose the block edit as action, file, and preview events.",
        status: "pending",
      },
    ],
  });

  session = applyEvent(session, events, {
    type: "message.delta",
    messageId,
    text: ` Prompt: ${options.suggestedPrompt}`,
  });

  const coderStream = gateway.streamCode({
    prompt: options.suggestedPrompt,
  });
  const { session: codedSession, events: codedEvents } = await collectEventStream(session, coderStream);
  session = codedSession;
  events.push(...codedEvents);

  const fileAction = createTimelineAction({
    source: "coder",
    action: {
      type: "file.patch",
      path: options.targetPath,
      patch: [
        `// block-edit:${options.blockId}`,
        "export const blockEditPatchPreview = {",
        `  blockId: '${options.blockId}',`,
        `  targetPath: '${options.targetPath}',`,
        `  prompt: ${JSON.stringify(options.suggestedPrompt)},`,
        `  coderModel: '${gateway.getProfile().coding.model}',`,
        "};",
      ].join("\n"),
    },
  });

  session = applyEvent(session, events, {
    type: "interaction.required",
    interaction: {
      type: "confirm",
      id: crypto.randomUUID(),
      title: `Review patch for ${options.blockId}`,
      summary: `This patch updates ${options.targetPath}. Confirm the block-scoped edit before applying it to the runtime replay.`,
      actionId: fileAction.id,
    },
  });

  session = applyEvent(session, events, {
    type: "action.created",
    action: fileAction,
  });

  session = applyEvent(session, events, {
    type: "message.completed",
    messageId,
  });

  sessionStore.upsert(session);

  return events;
}

async function snapshotWorkspaceFiles(runtime: RuntimeAdapter): Promise<WorkspaceFileEntry[]> {
  const paths = await runtime.listFiles("");
  return Promise.all(
    paths.map(async (path) => ({ path, content: await runtime.readFile(path) })),
  );
}

export async function executeApprovedBlockEdit(
  options: ApprovedBlockEditExecutionOptions,
): Promise<ApprovedBlockEditExecutionResult> {
  const sessionStore = createSessionStore();
  let session = createSessionState({
    id: options.sessionId,
    projectId: options.projectId,
  });
  const events: AgentEvent[] = [];

  sessionStore.upsert(session);

  const runtime = options.runtime;
  const executor = createExecutor({ runtime, sessionStore });
  const stopBridging = await bridgeRuntimeEvents({
    runtime,
    apply: (event) => {
      session = applyEvent(session, events, event);
    },
  });

  const completedAction = await executor.enqueue(options.action);
  session = applyEvent(session, events, {
    type: "action.updated",
    action: completedAction,
  });

  let workspaceFiles = options.workspaceFiles ?? [];

  if (completedAction.status === "completed") {
    if (completedAction.action.type === "file.patch" || completedAction.action.type === "file.write") {
      workspaceFiles = await snapshotWorkspaceFiles(runtime);
    }

    const previewAction = createTimelineAction({
      source: "system",
      action: {
        type: "preview.open",
        port: 4174,
      },
    });

    session = applyEvent(session, events, {
      type: "action.created",
      action: previewAction,
    });

    const completedPreviewAction = await executor.enqueue(previewAction);
    session = applyEvent(session, events, {
      type: "action.updated",
      action: completedPreviewAction,
    });
  }

  sessionStore.upsert(session);
  stopBridging();

  return { events, workspaceFiles };
}

export async function bootstrapReplacementBlockEditDemo(
  options: ReplacementBlockEditDemoOptions,
): Promise<AgentEvent[]> {
  const sessionStore = createSessionStore();
  let session = createSessionState({
    id: options.sessionId,
    projectId: options.projectId,
  });
  const events: AgentEvent[] = [];
  const gateway = createModelGateway();
  const runtime = createBrowserRuntimeStub();
  const executor = createExecutor({ runtime, sessionStore });
  const messageId = crypto.randomUUID();
  const stopBridging = await bridgeRuntimeEvents({
    runtime,
    apply: (event) => {
      session = applyEvent(session, events, event);
    },
  });

  session = applyEvent(session, events, {
    type: "message.delta",
    messageId,
    text: `Planner is replacing the ${options.blockId} patch with a structural alternative after rejection.`,
  });

  session = applyEvent(session, events, {
    type: "plan.updated",
    plan: [
      {
        id: crypto.randomUUID(),
        title: "Capture the rejected patch as failed context",
        description: "Keep the rejected patch visible for audit and comparison.",
        status: "completed",
      },
      {
        id: crypto.randomUUID(),
        title: `Replace the ${options.blockId} structure`,
        description: `Generate a broader replacement patch for ${options.targetPath}.`,
        status: "in_progress",
      },
      {
        id: crypto.randomUUID(),
        title: "Replay the replacement patch in the workbench",
        description: "Attach the new structure patch to diff, timeline, and preview state.",
        status: "pending",
      },
    ],
  });

  session = applyEvent(session, events, {
    type: "message.delta",
    messageId,
    text: ` Replacement prompt: ${options.suggestedPrompt}`,
  });

  session = applyEvent(session, events, {
    type: "message.delta",
    messageId,
    text: ` Reject reason: ${normalizeReason(options.rejectionReason)}`,
  });

  const coderStream = gateway.streamCode({
    prompt: options.suggestedPrompt,
  });
  const { session: codedSession, events: codedEvents } = await collectEventStream(session, coderStream);
  session = codedSession;
  events.push(...codedEvents);

  const replacementAction = createTimelineAction({
    source: "coder",
    action: {
      type: "file.patch",
      path: options.targetPath,
      patch: createReplacementStructurePatch(options, gateway.getProfile().coding.model),
    },
  });

  session = applyEvent(session, events, {
    type: "action.created",
    action: replacementAction,
  });

  const completedReplacementAction = await executor.enqueue(replacementAction);
  session = applyEvent(session, events, {
    type: "action.updated",
    action: completedReplacementAction,
  });

  const previewAction = createTimelineAction({
    source: "system",
    action: {
      type: "preview.open",
      port: 4174,
    },
  });

  session = applyEvent(session, events, {
    type: "action.created",
    action: previewAction,
  });

  const completedPreviewAction = await executor.enqueue(previewAction);
  session = applyEvent(session, events, {
    type: "action.updated",
    action: completedPreviewAction,
  });

  session = applyEvent(session, events, {
    type: "message.completed",
    messageId,
  });

  sessionStore.upsert(session);
  stopBridging();

  return events;
}

export async function bootstrapAgentApp(options: AgentAppOptions): Promise<AgentEvent[]> {
  const sessionStore = createSessionStore();
  let session = createSessionState({
    id: options.sessionId,
    projectId: options.projectId,
  });
  const events: AgentEvent[] = [];

  sessionStore.upsert(session);

  const gateway = createModelGateway();
  const runtime = createBrowserRuntimeStub();
  const executor = createExecutor({ runtime, sessionStore });
  const stopBridging = await bridgeRuntimeEvents({
    runtime,
    apply: (event) => {
      session = applyAgentEvent(session, event);
      events.push(event);
    },
  });
  const { session: plannedSession, events: plannedEvents } = await collectEventStream(
    session,
    gateway.streamPlan({
      prompt: "Initialize the workspace code structure for the new AI IDE.",
    }),
  );
  events.push(...plannedEvents);

  session = plannedSession;
  sessionStore.upsert(session);

  const fileAction = createTimelineAction({
    source: "coder",
    action: {
      type: "file.write",
      path: "apps/web/src/generated-bootstrap.ts",
      content: [
        "export const generatedBootstrap = {",
        "  status: 'ready',",
        "  source: 'agent-demo',",
        "};",
      ].join("\n"),
    },
  });

  const previewAction = createTimelineAction({
    source: "system",
    action: {
      type: "preview.open",
      port: 4174,
    },
  });

  const createdFileEvent: AgentEvent = {
    type: "action.created",
    action: fileAction,
  };
  events.push(createdFileEvent);
  session = applyAgentEvent(session, createdFileEvent);

  const completedFileAction = await executor.enqueue(fileAction);
  const updatedFileEvent: AgentEvent = {
    type: "action.updated",
    action: completedFileAction,
  };
  events.push(updatedFileEvent);
  session = applyAgentEvent(session, updatedFileEvent);

  const createdPreviewEvent: AgentEvent = {
    type: "action.created",
    action: previewAction,
  };
  events.push(createdPreviewEvent);
  session = applyAgentEvent(session, createdPreviewEvent);

  const completedPreviewEvent: AgentEvent = {
    type: "action.updated",
    action: await executor.enqueue(previewAction),
  };
  events.push(completedPreviewEvent);
  session = applyAgentEvent(session, completedPreviewEvent);

  const profileMessageEvent: AgentEvent = {
    type: "message.delta",
    messageId: "bootstrap-profile",
    text: `Planner profile: ${gateway.getProfile().planning.model}`,
  };
  events.push(profileMessageEvent);
  session = applyAgentEvent(session, profileMessageEvent);

  const coderProfileEvent: AgentEvent = {
    type: "message.delta",
    messageId: "bootstrap-profile-coder",
    text: `Coder profile: ${gateway.getProfile().coding.model}`,
  };
  events.push(coderProfileEvent);
  session = applyAgentEvent(session, coderProfileEvent);

  const profileCompletedEvent: AgentEvent = {
    type: "message.completed",
    messageId: "bootstrap-profile",
  };
  events.push(profileCompletedEvent);
  session = applyAgentEvent(session, profileCompletedEvent);

  const coderProfileCompletedEvent: AgentEvent = {
    type: "message.completed",
    messageId: "bootstrap-profile-coder",
  };
  events.push(coderProfileCompletedEvent);
  session = applyAgentEvent(session, coderProfileCompletedEvent);

  const summaryProfileEvent: AgentEvent = {
    type: "message.delta",
    messageId: "bootstrap-profile-summary",
    text: `Summary profile: ${gateway.getProfile().summary.model}`,
  };
  events.push(summaryProfileEvent);
  session = applyAgentEvent(session, summaryProfileEvent);

  const summaryProfileCompletedEvent: AgentEvent = {
    type: "message.completed",
    messageId: "bootstrap-profile-summary",
  };
  events.push(summaryProfileCompletedEvent);
  session = applyAgentEvent(session, summaryProfileCompletedEvent);

  sessionStore.upsert(session);
  stopBridging();

  return events;
}
