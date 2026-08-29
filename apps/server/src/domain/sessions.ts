import { bootstrapBlockEditDemo, executeApprovedBlockEdit } from "@ezu/agent";
import { type ActionState, type AgentEvent } from "@ezu/protocol";

import {
  createDemoBootstrap,
  getDemoSessionDefinition,
  type DemoSessionDefinition,
} from "./demo.js";
import { buildChoiceResolutionEvent, buildInputResolutionEvent } from "./interaction.js";
import { createReplacementPrompt } from "./replacement.js";
import {
  createMemorySessionRepository,
  type SessionRecord,
  type SessionRepository,
} from "./session-repository.js";
import {
  createInteractiveWebEditorState,
  createInteractiveWebEditResponse,
  createWorkbenchViewModel,
  getWebEditorBlockFile,
  selectInteractiveWebEditorBlock,
  upsertInteractiveWebEditorProperty,
  type InteractiveWebEditRequest,
  type WebAppBootstrap,
  type WebEditorProperty,
  type WorkbenchViewModel,
} from "./view-model.js";
import { type WorkspaceFileEntry } from "./workspace.js";

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

export class SessionNotFoundError extends Error {}
export class InteractionConflictError extends Error {}
export class ActionRetryConflictError extends Error {}
export { InteractionValidationError } from "./interaction.js";

let sessionRepository = createMemorySessionRepository();

export function configureSessionRepository(repository: SessionRepository): void {
  sessionRepository = repository;
}

export async function recoverSessionsOnStartup(): Promise<void> {
  await sessionRepository.recoverInterruptedSessions();
}

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

export async function createSession(definitionId: string, ownerUserId?: string): Promise<SessionDto> {
  const definition = getDemoSessionDefinition(definitionId);
  const generatedBootstrap = await createDemoBootstrap(definition.id);
  const sessionId = crypto.randomUUID();
  const bootstrap = { ...generatedBootstrap, sessionId };

  const record: SessionRecord = {
    id: sessionId,
    definitionId: definition.id,
    bootstrap,
    events: [...bootstrap.initialEvents],
    webEditor: createInteractiveWebEditorState(bootstrap.webEditor),
    ...(ownerUserId ? { ownerUserId } : {}),
  };

  await sessionRepository.create(record);
  return toDto(record);
}

async function ensureSession(sessionId: string, requestingUserId?: string): Promise<SessionRecord> {
  const existing = await sessionRepository.get(sessionId);
  if (!existing) {
    throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
  }
  if (existing.ownerUserId && existing.ownerUserId !== requestingUserId) {
    // Owned sessions are hidden from anonymous callers and other users.
    throw new SessionNotFoundError(`Unknown session: ${sessionId}`);
  }
  return existing;
}

export async function getSession(sessionId: string, requestingUserId?: string): Promise<SessionDto> {
  return toDto(await ensureSession(sessionId, requestingUserId));
}

export type OwnedSessionSummary = Pick<
  SessionDto,
  "id" | "projectName" | "description" | "taskTitle" | "taskTimestamp"
>;

export async function listSessionsForOwner(ownerUserId: string): Promise<OwnedSessionSummary[]> {
  const records = await sessionRepository.list();
  return records
    .filter((record) => record.ownerUserId === ownerUserId)
    .map((record) => {
      const definition = getDemoSessionDefinition(record.definitionId);
      return {
        id: record.id,
        projectName: definition.projectName,
        description: definition.description,
        taskTitle: definition.taskTitle,
        taskTimestamp: definition.taskTimestamp,
      };
    });
}

export async function getSessionWorkspaceFiles(
  sessionId: string,
  requestingUserId?: string,
): Promise<WorkspaceFileEntry[]> {
  const record = await ensureSession(sessionId, requestingUserId);
  return record.bootstrap.workspaceFiles ?? [];
}

export async function selectBlock(
  sessionId: string,
  blockId: string,
  requestingUserId?: string,
): Promise<SessionDto> {
  const record = await ensureSession(sessionId, requestingUserId);
  record.webEditor = selectInteractiveWebEditorBlock(record.webEditor, blockId);
  await sessionRepository.save(record);
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
  requestingUserId?: string,
): Promise<SessionDto> {
  const record = await ensureSession(sessionId, requestingUserId);
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

  await sessionRepository.save(record);
  return toDto(record);
}

export async function sendPrompt(
  sessionId: string,
  text: string,
  requestingUserId?: string,
): Promise<SessionDto> {
  const record = await ensureSession(sessionId, requestingUserId);
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
  const userMessageId = crypto.randomUUID();
  record.events.push({
    type: "message.delta",
    messageId: userMessageId,
    role: "user",
    text,
  });
  record.events.push({
    type: "message.completed",
    messageId: userMessageId,
  });

  const agentEvents = await bootstrapBlockEditDemo({
    sessionId: record.id,
    projectId: record.bootstrap.projectId,
    blockId,
    targetPath: getWebEditorBlockFile(blockId),
    suggestedPrompt: response.suggestedPrompt,
  });
  record.events.push(...dropNoisyEvents(agentEvents));

  await sessionRepository.save(record);
  return toDto(record);
}

function findPendingInteraction(
  events: AgentEvent[],
  interactionId: string,
): Extract<AgentEvent, { type: "interaction.required" }> {
  const resolvedIds = new Set(
    events
      .filter(
        (event): event is Extract<AgentEvent, { type: "interaction.resolved" }> =>
          event.type === "interaction.resolved",
      )
      .map((event) => event.interactionId),
  );
  const pending = events
    .slice()
    .reverse()
    .find(
      (event): event is Extract<AgentEvent, { type: "interaction.required" }> =>
        event.type === "interaction.required" && !resolvedIds.has(event.interaction.id),
    );

  if (!pending || pending.interaction.id !== interactionId) {
    throw new InteractionConflictError("The interaction is missing, stale, or already resolved");
  }

  return pending;
}

function findActionState(events: AgentEvent[], actionId: string): ActionState | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if ((event.type === "action.created" || event.type === "action.updated") && event.action.id === actionId) {
      return event.action;
    }
  }
  return undefined;
}

export async function resolveApproval(
  sessionId: string,
  interactionId: string,
  decision: "approved" | "rejected",
  reason: string,
  requestingUserId?: string,
): Promise<SessionDto> {
  const record = await ensureSession(sessionId, requestingUserId);
  const pending = findPendingInteraction(record.events, interactionId);
  if (pending.interaction.type !== "confirm") {
    throw new InteractionConflictError("This interaction requires a choice or text response");
  }

  const gatedAction = pending.interaction.actionId
    ? findActionState(record.events, pending.interaction.actionId)
    : undefined;

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

  if (decision === "approved") {
    if (gatedAction && gatedAction.status === "pending") {
      const executionEvents = await executeApprovedBlockEdit({
        sessionId: record.id,
        projectId: record.bootstrap.projectId,
        action: gatedAction,
      });
      record.events.push(...dropNoisyEvents(executionEvents));
    }
  } else {
    if (gatedAction && gatedAction.status === "pending") {
      record.events.push({
        type: "action.updated",
        action: { ...gatedAction, status: "cancelled", updatedAt: new Date().toISOString() },
      });
    }

    const selectedEditor = createInteractiveWebEditorState(record.webEditor);
    record.webEditor = {
      ...selectedEditor,
      suggestedPrompt: createReplacementPrompt(
        selectedEditor.suggestedPrompt ?? "Replace the current patch.",
        reason,
      ),
    };
  }

  await sessionRepository.save(record);
  return toDto(record);
}

export async function resolveChoiceInteraction(
  sessionId: string,
  interactionId: string,
  optionId: string,
  requestingUserId?: string,
): Promise<SessionDto> {
  const record = await ensureSession(sessionId, requestingUserId);
  const pending = findPendingInteraction(record.events, interactionId);
  if (pending.interaction.type !== "choice") {
    throw new InteractionConflictError("This interaction requires an approval decision");
  }

  record.events.push(buildChoiceResolutionEvent(pending.interaction, optionId));
  await sessionRepository.save(record);
  return toDto(record);
}

export async function resolveInputInteraction(
  sessionId: string,
  interactionId: string,
  value: string,
  requestingUserId?: string,
): Promise<SessionDto> {
  const record = await ensureSession(sessionId, requestingUserId);
  const pending = findPendingInteraction(record.events, interactionId);
  if (pending.interaction.type !== "input") {
    throw new InteractionConflictError("This interaction requires an approval decision");
  }

  record.events.push(buildInputResolutionEvent(pending.interaction, value));
  await sessionRepository.save(record);
  return toDto(record);
}

export async function retryAction(
  sessionId: string,
  actionId: string,
  requestingUserId?: string,
): Promise<SessionDto> {
  const record = await ensureSession(sessionId, requestingUserId);
  const current = findActionState(record.events, actionId);

  if (!current) {
    throw new ActionRetryConflictError(`Unknown action: ${actionId}`);
  }

  if (current.status === "completed") {
    throw new ActionRetryConflictError("This action already completed and cannot be retried");
  }

  if (current.status !== "failed") {
    throw new ActionRetryConflictError(`Action is not in a retryable state: ${current.status}`);
  }

  const { error: _previousError, ...currentWithoutError } = current;
  const retryingAction: ActionState = {
    ...currentWithoutError,
    status: "pending",
    updatedAt: new Date().toISOString(),
  };
  record.events.push({ type: "action.updated", action: retryingAction });

  const executionEvents = await executeApprovedBlockEdit({
    sessionId: record.id,
    projectId: record.bootstrap.projectId,
    action: retryingAction,
  });
  record.events.push(...dropNoisyEvents(executionEvents));

  await sessionRepository.save(record);
  return toDto(record);
}
