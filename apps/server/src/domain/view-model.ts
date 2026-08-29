import { applyAgentEvent, createSessionState } from "@ezu/core";
import { type ActionState, type AgentEvent } from "@ezu/protocol";

import { type WorkspaceFileEntry } from "./workspace.js";

export type PatchActionState = ActionState & {
  action: Extract<ActionState["action"], { type: "file.patch" }>;
};

export interface WebAppShellConfig {
  projectName: string;
  runtimeType: "browser" | "remote";
}

export interface WebAppBootstrap {
  config: WebAppShellConfig;
  initialEvents: AgentEvent[];
  sessionId: string;
  projectId: string;
  workspaceRoot?: string;
  workspaceFiles?: WorkspaceFileEntry[];
  webEditor?: Partial<InteractiveWebEditorState>;
  selectedDiffActionId?: string;
}

export type ViewMode = "preview" | "code" | "diff";
export type PreviewMode = "runtime" | "review";

export interface WorkbenchViewModel {
  chatMessages: Array<{ id: string; role: string; content: string }>;
  plan: WebAppEventState["plan"];
  actions: WebAppEventState["actions"];
  pendingInteraction: WebAppEventState["pendingInteraction"];
  files: string[];
  previews: WebAppEventState["runtime"]["openPorts"];
  webEditor: InteractiveWebEditorState;
  selectedBlock?: WebEditorBlock;
  selectedBlockFile?: string;
  patchActions: PatchActionState[];
  selectedDiffAction?: PatchActionState;
  approvalDecision?: ApprovalDecisionState;
}

export interface ApprovalDecisionState {
  status: "approved" | "rejected" | "answered";
  title: string;
  summary: string;
  rejectionReason?: string;
  followUpStrategy?: "revise" | "replace_structure";
  optionId?: string;
  value?: string;
}

export interface WebAppEventState {
  messages: ReturnType<typeof createSessionState>["messages"];
  plan: ReturnType<typeof createSessionState>["plan"];
  actions: ReturnType<typeof createSessionState>["actions"];
  pendingInteraction: ReturnType<typeof createSessionState>["pendingInteraction"];
  runtime: ReturnType<typeof createSessionState>["runtime"];
  approvalDecision?: ApprovalDecisionState;
}

export interface WebEditorBlock {
  id: string;
  label: string;
  selector: string;
  html: string;
  notes?: string;
}

export interface WebEditorProperty {
  key: string;
  label: string;
  value: string;
}

export interface WebEditorSelection {
  blockId: string;
  path: string;
}

export interface InteractiveWebEditorState {
  selectedBlockId?: string;
  blocks: WebEditorBlock[];
  properties: WebEditorProperty[];
  lastIntent?: string;
  suggestedPrompt?: string;
}

export interface InteractiveWebEditRequest {
  selection: WebEditorSelection;
  intent: string;
  patchStrategy: "replace" | "append" | "refine";
  properties?: WebEditorProperty[];
}

export interface InteractiveWebEditResponse {
  nextState: InteractiveWebEditorState;
  suggestedPrompt: string;
}

export function reduceWorkbenchEvents(
  input: Pick<WebAppBootstrap, "initialEvents" | "projectId" | "sessionId">,
): WebAppEventState {
  let session = createSessionState({
    id: input.sessionId,
    projectId: input.projectId,
  });
  let approvalDecision: ApprovalDecisionState | undefined;

  for (const event of input.initialEvents) {
    session = applyAgentEvent(session, event);

    if (event.type === "interaction.resolved") {
      approvalDecision = {
        status: event.status,
        title: event.title,
        summary: event.summary,
        ...(event.rejectionReason ? { rejectionReason: event.rejectionReason } : {}),
        ...(event.followUpStrategy ? { followUpStrategy: event.followUpStrategy } : {}),
        ...(event.optionId ? { optionId: event.optionId } : {}),
        ...(event.value ? { value: event.value } : {}),
      };
    }
  }

  return {
    messages: session.messages,
    plan: session.plan,
    actions: session.actions,
    pendingInteraction: session.pendingInteraction,
    runtime: session.runtime,
    ...(approvalDecision ? { approvalDecision } : {}),
  };
}

export function createWorkbenchViewModel(input: WebAppBootstrap): WorkbenchViewModel {
  const state = reduceWorkbenchEvents(input);
  const webEditor = createInteractiveWebEditorState(input.webEditor);
  const selectedBlock =
    webEditor.blocks.find((block) => block.id === webEditor.selectedBlockId) ?? webEditor.blocks[0];
  const selectedBlockFile = selectedBlock ? getWebEditorBlockFile(selectedBlock.id) : undefined;
  const patchActions = state.actions.filter(
    (action): action is PatchActionState => action.action.type === "file.patch",
  );
  const selectedDiffAction =
    patchActions.find((action) => action.id === input.selectedDiffActionId) ??
    patchActions[patchActions.length - 1];

  return {
    chatMessages: state.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
    })),
    plan: state.plan,
    actions: state.actions,
    pendingInteraction: state.pendingInteraction,
    files: state.runtime.files,
    previews: state.runtime.openPorts,
    webEditor,
    ...(selectedBlock ? { selectedBlock } : {}),
    ...(selectedBlockFile ? { selectedBlockFile } : {}),
    patchActions,
    ...(selectedDiffAction ? { selectedDiffAction } : {}),
    ...(state.approvalDecision ? { approvalDecision: state.approvalDecision } : {}),
  };
}

export function createInteractiveWebEditorState(
  overrides: Partial<InteractiveWebEditorState> = {},
): InteractiveWebEditorState {
  const blocks =
    overrides.blocks ??
    [
      {
        id: "hero",
        label: "Hero Banner",
        selector: "main > header.topbar",
        html: "<header class='topbar'>...</header>",
        notes: "Primary workspace identity, title, and runtime context.",
      },
      {
        id: "conversation",
        label: "Conversation Stack",
        selector: "section.layout > section:nth-of-type(1)",
        html: "<section class='panel stack'>...</section>",
        notes: "Chat, plan, interaction, and action history.",
      },
      {
        id: "workbench",
        label: "Workbench Surface",
        selector: "section.layout > section:nth-of-type(2)",
        html: "<section class='panel stack'>...</section>",
        notes: "Files, editor, preview, terminal, and diff.",
      },
    ];
  const selectedBlockId = overrides.selectedBlockId ?? blocks[0]?.id;
  const selectedBlock = blocks.find((block) => block.id === selectedBlockId) ?? blocks[0];

  return {
    ...(selectedBlockId ? { selectedBlockId } : {}),
    blocks,
    properties:
      overrides.properties ??
      [
        {
          key: "headline",
          label: "Headline",
          value: selectedBlock?.label ?? "Hero Banner",
        },
        {
          key: "tone",
          label: "Tone",
          value: "Operational",
        },
        {
          key: "visual_focus",
          label: "Visual Focus",
          value: "Execution visibility",
        },
      ],
    ...(overrides.lastIntent ? { lastIntent: overrides.lastIntent } : {}),
    ...(overrides.suggestedPrompt ? { suggestedPrompt: overrides.suggestedPrompt } : {}),
  };
}

export function createInteractiveWebEditResponse(
  request: InteractiveWebEditRequest,
  state: InteractiveWebEditorState = createInteractiveWebEditorState(),
): InteractiveWebEditResponse {
  const selectedBlock =
    state.blocks.find((block) => block.id === request.selection.blockId) ?? state.blocks[0];
  const nextState = createInteractiveWebEditorState({
    ...state,
    selectedBlockId: request.selection.blockId,
    properties: request.properties ?? state.properties,
    lastIntent: request.intent,
    suggestedPrompt: "",
  });
  const propertySummary = (request.properties ?? [])
    .map((property) => `${property.label}: ${property.value}`)
    .join(", ");

  const suggestedPrompt = [
    `Update page block ${request.selection.blockId} at ${request.selection.path}.`,
    `Strategy: ${request.patchStrategy}.`,
    `Intent: ${request.intent}.`,
    selectedBlock ? `Selector: ${selectedBlock.selector}.` : "",
    propertySummary ? `Properties: ${propertySummary}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    nextState: {
      ...nextState,
      suggestedPrompt,
    },
    suggestedPrompt,
  };
}

export function selectInteractiveWebEditorBlock(
  state: InteractiveWebEditorState,
  blockId: string,
): InteractiveWebEditorState {
  const block = state.blocks.find((item) => item.id === blockId) ?? state.blocks[0];

  return createInteractiveWebEditorState({
    ...state,
    selectedBlockId: blockId,
    properties: state.properties.map((property) =>
      property.key === "headline"
        ? {
            ...property,
            value: block?.label ?? property.value,
          }
        : property,
    ),
  });
}

export function upsertInteractiveWebEditorProperty(
  state: InteractiveWebEditorState,
  nextProperty: WebEditorProperty,
): InteractiveWebEditorState {
  const exists = state.properties.some((property) => property.key === nextProperty.key);

  return createInteractiveWebEditorState({
    ...state,
    properties: exists
      ? state.properties.map((property) =>
          property.key === nextProperty.key ? nextProperty : property,
        )
      : [...state.properties, nextProperty],
  });
}

export function getWebEditorBlockFile(blockId: string): string {
  if (blockId === "hero") {
    return "apps/web/src/index.ts";
  }

  if (blockId === "conversation") {
    return "apps/agent/src/index.ts";
  }

  if (blockId === "workbench") {
    return "apps/web/src/main.ts";
  }

  return "apps/web/src/index.ts";
}
