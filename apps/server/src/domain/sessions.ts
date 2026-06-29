import { bootstrapBlockEditDemo } from "@ezu/agent";
import { type AgentEvent } from "@ezu/protocol";

import {
  createDemoBootstrap,
  getDemoSessionDefinition,
  type DemoSessionDefinition,
} from "./demo.js";
import { createReplacementPrompt } from "./replacement.js";
import {
  createInteractiveWebEditorState,
  createInteractiveWebEditResponse,
  createWorkbenchViewModel,
  getWebEditorBlockFile,
  selectInteractiveWebEditorBlock,
  upsertInteractiveWebEditorProperty,
  type InteractiveWebEditorState,
  type InteractiveWebEditRequest,
  type WebAppBootstrap,
  type WebEditorProperty,
  type WorkbenchViewModel,
} from "./view-model.js";
import { type WorkspaceFileEntry } from "./workspace.js";

interface SessionRecord {
  id: string;
  definitionId: string;
  bootstrap: WebAppBootstrap;
  events: AgentEvent[];
  webEditor: InteractiveWebEditorState;
}

export interface SessionSummaryDto {
  id: string;
  title: string;
  projectName: string;
  description: string;
  taskTitle: string;
  taskTimestamp: string;
}

export interface SessionDto {
  id: string;
  definitionId: string;
  projectId: string;
  projectName: string;
  description: string;
  taskTitle: string;
  taskTimestamp: string;
  config: WebAppBootstrap["config"];
  workspaceRoot?: string;
  viewModel: WorkbenchViewModel;
}

const sessions = new Map<string, SessionRecord>();

function definitionToSummary(definition: DemoSessionDefinition): SessionSummaryDto {
  return {
    id: definition.id,
    title: definition.title,
    projectName: definition.projectName,
    description: definition.description,
    taskTitle: definition.taskTitle,
    taskTimestamp: definition.taskTimestamp,
  };
}

function toBootstrapInput(record: SessionRecord): WebAppBootstrap {
  return {
    ...record.bootstrap,
    initialEvents: record.events,
    webEditor: record.webEditor,
  };
}

function toDto(record: SessionRecord): SessionDto {
  const definition = getDemoSessionDefinition(record.definitionId);
  const bootstrap = toBootstrapInput(record);

  return {
    id: record.id,
    definitionId: record.definitionId,
    projectId: record.bootstrap.projectId,
    projectName: definition.projectName,
    description: definition.description,
    taskTitle: definition.taskTitle,
    taskTimestamp: definition.taskTimestamp,
    config: record.bootstrap.config,
    ...(record.bootstrap.workspaceRoot ? { workspaceRoot: record.bootstrap.workspaceRoot } : {}),
    viewModel: createWorkbenchViewModel(bootstrap),
  };
}

function dropNoisyEvents(events: AgentEvent[]): AgentEvent[] {
  const dropMessageIds = new Set(
    events
      .filter(
        (event): event is Extract<AgentEvent, { type: "message.delta" }> =>
          event.type === "message.delta" &&
          /Bolt|Planner is translating|Update page block/i.test(event.text),
      )
      .map((event) => event.messageId),
  );

  return events.filter((event) => {
    if (event.type === "message.delta" || event.type === "message.completed") {
      return !dropMessageIds.has(event.messageId);
    }
    return true;
  });
}

export function listSessionDefinitions(): SessionSummaryDto[] {
  return [
    getDemoSessionDefinition("club-promo"),
    getDemoSessionDefinition("agency-redesign"),
    getDemoSessionDefinition("portfolio-dash"),
  ].map(definitionToSummary);
}

export async function createSession(definitionId: string): Promise<SessionDto> {
  const definition = getDemoSessionDefinition(definitionId);
  const bootstrap = await createDemoBootstrap(definition.id);

  const record: SessionRecord = {
    id: bootstrap.sessionId,
    definitionId: definition.id,
    bootstrap,
    events: [...bootstrap.initialEvents],
    webEditor: createInteractiveWebEditorState(bootstrap.webEditor),
  };

  sessions.set(record.id, record);
  return toDto(record);
}

async function ensureSession(sessionId: string): Promise<SessionRecord> {
  const existing = sessions.get(sessionId);
  if (existing) {
    return existing;
  }

  // Recreate a session from its definition id when the store was reset.
  const definitionId = sessionId.replace(/-session$/, "");
  await createSession(definitionId);
  const created = sessions.get(`${definitionId}-session`);
  if (!created) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  return created;
}

export async function getSession(sessionId: string): Promise<SessionDto> {
  return toDto(await ensureSession(sessionId));
}

export async function getSessionWorkspaceFiles(sessionId: string): Promise<WorkspaceFileEntry[]> {
  const record = await ensureSession(sessionId);
  return record.bootstrap.workspaceFiles ?? [];
}

export async function selectBlock(sessionId: string, blockId: string): Promise<SessionDto> {
  const record = await ensureSession(sessionId);
  record.webEditor = selectInteractiveWebEditorBlock(record.webEditor, blockId);
  return toDto(record);
}

export async function applyEdit(
  sessionId: string,
  input: {
    intent: string;
    patchStrategy: InteractiveWebEditRequest["patchStrategy"];
    properties?: WebEditorProperty[];
    runAgent?: boolean;
  },
): Promise<SessionDto> {
  const record = await ensureSession(sessionId);
  const selectedState = createInteractiveWebEditorState(record.webEditor);
  const blockId = selectedState.selectedBlockId ?? selectedState.blocks[0]?.id ?? "workbench";

  let nextEditorState = createInteractiveWebEditorState(record.webEditor);
  for (const property of input.properties ?? []) {
    nextEditorState = upsertInteractiveWebEditorProperty(nextEditorState, property);
  }

  const request: InteractiveWebEditRequest = {
    selection: {
      blockId,
      path: getWebEditorBlockFile(blockId),
    },
    intent: input.intent,
    patchStrategy: input.patchStrategy,
    ...(input.properties ? { properties: input.properties } : {}),
  };

  const response = createInteractiveWebEditResponse(request, nextEditorState);
  record.webEditor = response.nextState;

  if (input.runAgent !== false) {
    const agentEvents = await bootstrapBlockEditDemo({
      sessionId: record.id,
      projectId: record.bootstrap.projectId,
      blockId,
      targetPath: getWebEditorBlockFile(blockId),
      suggestedPrompt: response.suggestedPrompt,
    });
    record.events.push(...dropNoisyEvents(agentEvents));
  }

  return toDto(record);
}

export async function sendPrompt(sessionId: string, text: string): Promise<SessionDto> {
  const record = await ensureSession(sessionId);
  const selectedEditor = createInteractiveWebEditorState(record.webEditor);
  const blockId = selectedEditor.selectedBlockId ?? selectedEditor.blocks[0]?.id ?? "workbench";

  const response = createInteractiveWebEditResponse(
    {
      selection: { blockId, path: getWebEditorBlockFile(blockId) },
      intent: text,
      patchStrategy: "refine",
      properties: selectedEditor.properties,
    },
    selectedEditor,
  );
  record.webEditor = response.nextState;
  record.events.push({
    type: "message.delta",
    messageId: `assistant-ui-${Date.now()}`,
    text: `Queued prompt: ${text}`,
  });
  record.events.push({
    type: "message.completed",
    messageId: `assistant-ui-${Date.now()}`,
  });

  return toDto(record);
}

export async function resolveApproval(
  sessionId: string,
  decision: "approved" | "rejected",
  reason: string,
): Promise<SessionDto> {
  const record = await ensureSession(sessionId);
  const pending = record.events
    .slice()
    .reverse()
    .find(
      (event): event is Extract<AgentEvent, { type: "interaction.required" }> =>
        event.type === "interaction.required",
    );

  if (!pending || pending.interaction.type !== "confirm") {
    return toDto(record);
  }

  record.events.push({
    type: "interaction.resolved",
    interactionId: pending.interaction.id,
    status: decision,
    title: pending.interaction.title,
    summary:
      decision === "approved"
        ? `Approved: ${pending.interaction.summary}`
        : `Rejected: ${pending.interaction.summary}`,
    ...(decision === "rejected"
      ? { rejectionReason: reason, followUpStrategy: "replace_structure" as const }
      : {}),
  });

  if (decision === "rejected") {
    const selectedEditor = createInteractiveWebEditorState(record.webEditor);
    record.webEditor = {
      ...selectedEditor,
      suggestedPrompt: createReplacementPrompt(
        selectedEditor.suggestedPrompt ?? "Replace the current patch.",
        reason,
      ),
    };
  }

  return toDto(record);
}
