import { applyAgentEvent, createSessionState } from "@ezu/core";
import {
  centerWorkspacePanels,
  rightWorkbenchPanels,
  workspacePanelLabels,
} from "@ezu/ui";
import { type ActionState, type AgentEvent, type PendingInteraction } from "@ezu/protocol";
import { type WorkspaceFileEntry } from "./workspace";

export { createReplacementPrompt } from "./replacement.js";

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
  composerText?: string;
  activeFile?: string;
  viewMode?: ViewMode;
  previewMode?: PreviewMode;
  previewUrl?: string;
  previewAddress?: string;
  previewCanGoBack?: boolean;
  previewCanGoForward?: boolean;
  previewLoading?: boolean;
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
  status: "approved" | "rejected";
  title: string;
  summary: string;
  rejectionReason?: string;
  followUpStrategy?: "revise" | "replace_structure";
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

  return {
    nextState: {
      ...nextState,
      suggestedPrompt: [
        `Update page block ${request.selection.blockId} at ${request.selection.path}.`,
        `Strategy: ${request.patchStrategy}.`,
        `Intent: ${request.intent}.`,
        selectedBlock ? `Selector: ${selectedBlock.selector}.` : "",
        propertySummary ? `Properties: ${propertySummary}.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    },
    suggestedPrompt: [
      `Update page block ${request.selection.blockId} at ${request.selection.path}.`,
      `Strategy: ${request.patchStrategy}.`,
      `Intent: ${request.intent}.`,
      selectedBlock ? `Selector: ${selectedBlock.selector}.` : "",
      propertySummary ? `Properties: ${propertySummary}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderPlanStatus(status: string): string {
  return status.replaceAll("_", " ");
}

function summarizeAction(action: WorkbenchViewModel["actions"][number]["action"]): string {
  if (action.type === "file.write") {
    return `Write ${action.path}`;
  }

  if (action.type === "file.patch") {
    return `Patch ${action.path}`;
  }

  if (action.type === "command.run") {
    return `Run ${action.command}`;
  }

  if (action.type === "preview.open") {
    return `Open preview on port ${String(action.port ?? "unknown")}`;
  }

  if (action.type === "interaction.choice") {
    return action.question;
  }

  return action.title;
}

function summarizePatch(action: PatchActionState): string {
  const firstLine = action.action.patch.split("\n").find((line) => line.trim().length > 0);
  return firstLine ?? action.action.patch;
}

function renderPendingInteraction(interaction: PendingInteraction | undefined): string {
  if (!interaction) {
    return `<div class="empty-state">No pending interaction</div>`;
  }

  if (interaction.type === "choice") {
    return `
      <section class="card accent-card">
        <p class="eyebrow">Choice Required</p>
        <h3>${escapeHtml(interaction.question)}</h3>
        <ul class="option-list">
          ${interaction.options
            .map(
              (option) => `
                <li>
                  <strong>${escapeHtml(option.label)}</strong>
                  <p>${escapeHtml(option.description ?? "No description")}</p>
                </li>
              `,
            )
            .join("")}
        </ul>
      </section>
    `;
  }

  if (interaction.type === "confirm") {
    return `
      <section class="card accent-card">
        <p class="eyebrow">Confirmation</p>
        <h3>${escapeHtml(interaction.title)}</h3>
        <p>${escapeHtml(interaction.summary)}</p>
      </section>
    `;
  }

  return `
    <section class="card accent-card">
      <p class="eyebrow">Input Required</p>
      <h3>${escapeHtml(interaction.label)}</h3>
      <p>${escapeHtml(interaction.placeholder ?? "No placeholder provided")}</p>
    </section>
  `;
}

function renderWebEditor(state: InteractiveWebEditorState): string {
  const selectedBlock =
    state.blocks.find((block) => block.id === state.selectedBlockId) ?? state.blocks[0];
  const intentValue = escapeHtml(state.lastIntent ?? "");
  const selectedPath = escapeHtml(selectedBlock?.selector ?? "");

  return `
    <section class="card accent-card">
      <p class="eyebrow">Interactive Web Editor</p>
      <h3>${escapeHtml(selectedBlock?.label ?? "No block selected")}</h3>
      <p>${escapeHtml(selectedBlock?.notes ?? "Select a page block and refine it with intent plus structured properties.")}</p>
      <div class="subgrid">
        <div class="card">
          <p class="eyebrow">Blocks</p>
          <ul class="message-list">
            ${state.blocks
              .map(
                (block) => `
                  <li class="${block.id === state.selectedBlockId ? "selected-item" : ""}">
                    <button class="editor-block-button" data-block-id="${escapeHtml(block.id)}" type="button">
                      <strong>${escapeHtml(block.label)}</strong>
                      <span>${escapeHtml(block.selector)}</span>
                    </button>
                  </li>
                `,
              )
              .join("")}
          </ul>
        </div>
        <div class="card">
          <p class="eyebrow">Properties</p>
          <ul class="message-list">
            ${state.properties
              .map(
                (property) => `
                  <li>
                    <strong>${escapeHtml(property.label)}</strong>
                    <p>${escapeHtml(property.value)}</p>
                  </li>
                `,
              )
              .join("")}
          </ul>
        </div>
      </div>
      <form class="card editor-form" data-editor-form="interactive-web-editor">
        <p class="eyebrow">Patch Request</p>
        <label class="field">
          <span>Selected Path</span>
          <input name="path" value="${selectedPath}" readonly />
        </label>
        <label class="field">
          <span>Intent</span>
          <textarea name="intent" rows="3" placeholder="Describe the change">${intentValue}</textarea>
        </label>
        <div class="subgrid">
          ${state.properties
            .map(
              (property) => `
                <label class="field">
                  <span>${escapeHtml(property.label)}</span>
                  <input name="property:${escapeHtml(property.key)}" value="${escapeHtml(property.value)}" />
                </label>
              `,
            )
            .join("")}
        </div>
        <label class="field">
          <span>Patch Strategy</span>
          <select name="patchStrategy">
            <option value="refine" selected>refine</option>
            <option value="append">append</option>
            <option value="replace">replace</option>
          </select>
        </label>
        <button class="submit-button" type="submit">Generate Patch Prompt</button>
      </form>
      <div class="card">
        <p class="eyebrow">Intent</p>
        <p>${escapeHtml(state.lastIntent ?? "No edit request captured yet.")}</p>
      </div>
      <div class="card">
        <p class="eyebrow">Suggested Prompt</p>
        <p>${escapeHtml(state.suggestedPrompt ?? "Submit an edit request to generate a block-scoped prompt.")}</p>
      </div>
    </section>
  `;
}

function renderPreviewSelection(state: InteractiveWebEditorState, previewUrl?: string): string {
  const selectedBlock =
    state.blocks.find((block) => block.id === state.selectedBlockId) ?? state.blocks[0];

  return `
    <div class="card preview-surface">
      <p class="eyebrow">Preview Surface</p>
      <div class="preview-stack">
        ${state.blocks
          .map(
            (block) => `
              <button
                type="button"
                class="preview-block ${block.id === state.selectedBlockId ? "preview-block-active" : ""}"
                data-preview-block-id="${escapeHtml(block.id)}"
              >
                <span class="preview-block-label">${escapeHtml(block.label)}</span>
                <span class="preview-block-path">${escapeHtml(block.selector)}</span>
              </button>
            `,
          )
          .join("")}
      </div>
      <div class="card preview-detail">
        <p class="eyebrow">Selected Block</p>
        <h3>${escapeHtml(selectedBlock?.label ?? "No block selected")}</h3>
        <p>${escapeHtml(selectedBlock?.html ?? "No HTML snapshot")}</p>
      </div>
      ${
        previewUrl
          ? `
            <div class="card preview-detail">
              <p class="eyebrow">Live Preview</p>
              <iframe
                class="preview-frame"
                src="${escapeHtml(previewUrl)}"
                title="Live browser runtime preview"
                loading="lazy"
              ></iframe>
            </div>
          `
          : ""
      }
    </div>
  `;
}

function renderDiffPanel(workbench: WorkbenchViewModel): string {
  if (!workbench.selectedDiffAction) {
    return `<div class="empty-state dark-empty">
      Select a patch action from the timeline to inspect its diff here.
    </div>`;
  }

  const approvalActions =
    workbench.pendingInteraction?.type === "confirm"
      ? `
        <label class="approval-reason-field">
          <span>Reject Reason</span>
          <textarea
            class="approval-reason-input"
            data-reject-reason
            rows="3"
            placeholder="Explain what is wrong with this patch and what should change in the replacement."
          ></textarea>
        </label>
        <div class="approval-actions">
          <button type="button" class="approval-button approve-button" data-approval-decision="approved">
            Approve Patch
          </button>
          <button type="button" class="approval-button reject-button" data-approval-decision="rejected">
            Reject Patch
          </button>
        </div>
      `
      : "";

  const approvalCard =
    workbench.approvalDecision
      ? `
        <div class="card ${workbench.approvalDecision.status === "approved" ? "approval-success-card" : "approval-reject-card"}">
          <p class="eyebrow">${escapeHtml(workbench.approvalDecision.status)}</p>
          <h3>${escapeHtml(workbench.approvalDecision.title)}</h3>
          <p>${escapeHtml(workbench.approvalDecision.summary)}</p>
          ${
            workbench.approvalDecision.rejectionReason
              ? `<p><strong>Reject reason:</strong> ${escapeHtml(workbench.approvalDecision.rejectionReason)}</p>`
              : ""
          }
          ${
            workbench.approvalDecision.followUpStrategy
              ? `<p>Follow-up: ${escapeHtml(workbench.approvalDecision.followUpStrategy)}</p>`
              : ""
          }
        </div>
      `
      : workbench.pendingInteraction?.type === "confirm"
      ? `
        <div class="card approval-card">
          <p class="eyebrow">Approval Required</p>
          <h3>${escapeHtml(workbench.pendingInteraction.title)}</h3>
          <p>${escapeHtml(workbench.pendingInteraction.summary)}</p>
          ${approvalActions}
        </div>
      `
      : "";

  return `
    <div class="stack">
      ${approvalCard}
      <div class="card diff-header">
        <p class="eyebrow">Current Patch</p>
        <h3>${escapeHtml(workbench.selectedDiffAction.action.path)}</h3>
        <p>${escapeHtml(summarizePatch(workbench.selectedDiffAction))}</p>
      </div>
      <div class="card">
        <p class="eyebrow">Patch Actions</p>
        <ul class="message-list">
          ${workbench.patchActions
            .map(
              (action) => `
                <li class="${action.id === workbench.selectedDiffAction?.id ? "selected-item" : ""}">
                  <button
                    type="button"
                    class="timeline-action-button"
                    data-diff-action-id="${escapeHtml(action.id)}"
                    data-file-path="${escapeHtml(action.action.path)}"
                  >
                    <strong>${escapeHtml(action.action.path)}</strong>
                    <span>${escapeHtml(action.status)}</span>
                  </button>
                </li>
              `,
            )
            .join("")}
        </ul>
      </div>
      <div class="card code-block">
        <p class="eyebrow">Patch Content</p>
        <pre>${escapeHtml(workbench.selectedDiffAction.action.patch)}</pre>
      </div>
    </div>
  `;
}

function renderEditorCode(content: string): string {
  const lines = content.split("\n");

  return `
    <div class="code-view">
      <ol class="line-numbers">
        ${lines.map((_, index) => `<li>${String(index + 1)}</li>`).join("")}
      </ol>
      <ol class="code-lines">
        ${lines.map((line) => `<li class="code-line">${escapeHtml(line || " ")}</li>`).join("")}
      </ol>
    </div>
  `;
}

function renderSessionTerminal(workbench: WorkbenchViewModel): string {
  const preview = workbench.previews[workbench.previews.length - 1];
  const fileAction = [...workbench.actions]
    .reverse()
    .find((action) => action.action.type === "file.write" || action.action.type === "file.patch");
  const lines = [
    "Network: browser runtime ready",
    "watching session state and runtime events",
    fileAction ? `$ sync ${summarizeAction(fileAction.action)}` : "$ waiting for file activity",
    preview ? `preview ready: ${preview.url}` : "preview pending",
    "",
    `session:${workbench.chatMessages.length}-messages plan:${workbench.plan.length}-steps`,
    "~/project $",
  ];

  const body = lines
    .map((line, index) => {
      if (index === 0) {
        return `<p><span class="terminal-dot"></span> ${escapeHtml(line)}</p>`;
      }

      if (line.startsWith("$") || line.startsWith("~/")) {
        return `<p><span class="terminal-accent">${escapeHtml(line)}</span></p>`;
      }

      return `<p>${escapeHtml(line)}</p>`;
    })
    .join("");

  return `
    <div class="terminal">
      <div class="terminal-tabs">
        <span class="terminal-tab active">Output</span>
        <span class="terminal-tab-clear">clear</span>
      </div>
      <div class="terminal-body">${body}</div>
    </div>
  `;
}

function renderSessionPreview(
  workbench: WorkbenchViewModel,
  options: {
    previewUrl?: string;
    previewAddress?: string;
    canGoBack?: boolean;
    canGoForward?: boolean;
    loading?: boolean;
  } = {},
): string {
  const activePreview = workbench.previews[workbench.previews.length - 1];
  const resolvedPreviewUrl = options.previewUrl ?? activePreview?.url;

  if (!resolvedPreviewUrl) {
    return `<div class="empty-state dark-empty">No live preview yet</div>`;
  }

  return `
    <div class="browser-frame">
      <div class="browser-toolbar">
        <div class="browser-actions">
          <button class="browser-action" data-preview-nav="back" type="button" aria-label="Go back" ${options.canGoBack ? "" : "disabled"}>←</button>
          <button class="browser-action" data-preview-nav="forward" type="button" aria-label="Go forward" ${options.canGoForward ? "" : "disabled"}>→</button>
          <button class="browser-action" data-preview-nav="reload" type="button" aria-label="Reload">↻</button>
        </div>
        <form class="browser-url-form" data-preview-form>
          <input
            class="browser-url"
            data-preview-url-input
            name="url"
            value="${escapeHtml(options.previewAddress ?? resolvedPreviewUrl)}"
            spellcheck="false"
            autocomplete="off"
            placeholder="https://example.com"
          />
        </form>
        <button class="browser-action" data-preview-open type="button" aria-label="Open in new tab">↗</button>
      </div>
      <div class="browser-loading ${options.loading ? "browser-loading-active" : ""}">
        <span></span>
      </div>
      <iframe
        class="preview-frame"
        data-preview-frame
        src="${escapeHtml(resolvedPreviewUrl)}"
        title="Live browser runtime preview"
        loading="lazy"
      ></iframe>
    </div>
  `;
}

function renderSelectedFileCode(filePath: string, content: string): string {
  return `
    <div class="stack">
      <div class="card diff-header">
        <p class="eyebrow">Selected File</p>
        <h3>${escapeHtml(filePath)}</h3>
        <p>Code view for the current file selection.</p>
      </div>
      <div class="card code-block">
        <p class="eyebrow">Source</p>
        ${renderEditorCode(content)}
      </div>
    </div>
  `;
}

function renderModelOutput(workbench: WorkbenchViewModel): string {
  const lastAssistant = [...workbench.chatMessages]
    .reverse()
    .find((message) => message.role === "assistant");

  if (!lastAssistant) {
    return `<div class="empty-state dark-empty">No model output yet.</div>`;
  }

  return `
    <div class="output-card">
      <p class="eyebrow">Latest Output</p>
      <p>${escapeHtml(lastAssistant.content)}</p>
    </div>
  `;
}

function renderChatMessages(workbench: WorkbenchViewModel): string {
  if (workbench.chatMessages.length === 0) {
    return `<div class="empty-state dark-empty">No messages yet.</div>`;
  }

  return `
    <div class="chat-stream">
      ${workbench.chatMessages
        .map((message, index) => {
          const role = message.role ?? "assistant";
          const roleLabel =
            role === "assistant" ? "Ezu" : role === "user" ? "You" : "System";
          const content = escapeHtml(message.content).replaceAll("\n", "<br />");
          const rowClass = role === "user" ? "chat-row chat-row-user" : "chat-row";
          const bubbleClass =
            role === "user"
              ? "chat-bubble chat-bubble-user"
              : role === "system"
                ? "chat-bubble chat-bubble-system"
                : "chat-bubble";

          return `
            <div class="${rowClass}">
              <div class="${bubbleClass}">
                <p>${content}</p>
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

export const webAppStyles = `
  :root {
    color-scheme: dark;
    --bg: #060816;
    --bg-top: #08101d;
    --panel: #0d1422;
    --panel-2: #101a2a;
    --panel-3: #0a111d;
    --surface: #131d2d;
    --surface-2: #1a2436;
    --line: rgba(171, 212, 255, 0.12);
    --line-strong: rgba(171, 212, 255, 0.24);
    --text: #f5f7fb;
    --muted: #94a7c2;
    --dim: #70819b;
    --accent: #7cc4ff;
    --accent-soft: rgba(124, 196, 255, 0.14);
    --success: #4ade80;
    --danger: #f87171;
    --shadow: 0 28px 90px rgba(0, 0, 0, 0.42);
    --focus: rgba(124, 196, 255, 0.6);
  }

  * {
    box-sizing: border-box;
  }

  :where(button, a, input, textarea, select):focus {
    outline: none;
  }

  :where(button, a, input, textarea, select):focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 3px;
  }

  html,
  body {
    margin: 0;
    height: 100%;
    min-height: 100%;
    background:
      radial-gradient(circle at top left, rgba(124, 196, 255, 0.14), transparent 24%),
      radial-gradient(circle at top right, rgba(124, 196, 255, 0.08), transparent 20%),
      linear-gradient(180deg, #060816 0%, #09111d 100%);
    color: var(--text);
    font-family: Inter, "Segoe UI", sans-serif;
    text-rendering: optimizeLegibility;
    overflow: hidden;
  }

  a {
    color: inherit;
    text-decoration: none;
  }

  button,
  input,
  textarea,
  select {
    font: inherit;
  }

  .app-shell {
    height: 100vh;
    height: 100dvh;
    min-height: 100vh;
    padding: 0;
  }

  .workspace-shell {
    height: calc(100vh - 28px);
    height: calc(100dvh - 28px);
    min-height: calc(100vh - 28px);
    display: grid;
    grid-template-rows: auto 1fr;
    border: 0;
    border-radius: 0;
    overflow: hidden;
    background: rgba(6, 8, 22, 0.94);
    box-shadow: none;
  }

  .workspace-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--line);
    background: rgba(13, 20, 34, 0.96);
  }

  .workspace-topbar,
  .topbar-left,
  .topbar-right,
  .topbar-actions,
  .topbar-crumbs {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .brand-mark,
  .toolbar-chip,
  .avatar {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: var(--surface);
    border: 1px solid var(--line);
    color: var(--text);
  }

  .toolbar-chip {
    cursor: pointer;
    font: inherit;
    padding: 0;
  }

  .toolbar-chip-active {
    background: var(--accent-soft);
    border-color: rgba(124, 196, 255, 0.5);
    color: #dbe7ff;
  }

  .brand-mark {
    font-style: italic;
    font-weight: 800;
  }

  .brand-home {
    padding: 0;
    cursor: pointer;
    font: inherit;
  }

  .brand-home:hover {
    border-color: rgba(124, 196, 255, 0.5);
    background: var(--accent-soft);
  }

  .brand-home:focus-visible {
    outline-offset: 4px;
  }

  .topbar-title {
    color: var(--text);
    font-weight: 600;
    font-size: 0.95rem;
  }

  .crumb-muted,
  .workspace-topbar p,
  .meta,
  li {
    color: var(--muted);
  }

  .topbar-button {
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
    color: var(--text);
    padding: 8px 12px;
    cursor: pointer;
    transition:
      transform 160ms ease,
      background 160ms ease,
      border-color 160ms ease;
  }

  .topbar-button:hover {
    border-color: var(--line-strong);
    background: rgba(124, 196, 255, 0.1);
    transform: translateY(-1px);
  }

  .topbar-button:active {
    transform: translateY(0px);
  }

  .topbar-button-primary {
    background: #7cc4ff;
    color: #08101d;
    font-weight: 650;
  }

  .topbar-button-primary:hover {
    background: #8fd0ff;
  }

  .workspace-content {
    display: grid;
    grid-template-columns: minmax(280px, 0.34fr) minmax(0, 1fr);
    min-height: 0;
  }

  .chat-shell {
    display: grid;
    grid-template-rows: auto 1fr auto;
    border-right: 1px solid var(--line);
    background: rgba(16, 19, 25, 0.94);
    min-height: 0;
  }

  .chat-header {
    padding: 16px 16px 12px;
    display: grid;
    gap: 12px;
    border-bottom: 1px solid var(--line);
  }

  .chat-title {
    display: grid;
    gap: 6px;
  }

  .chat-title h2 {
    margin: 0;
    font-size: 1.05rem;
    letter-spacing: -0.02em;
  }

  .chat-tools {
    display: grid;
    gap: 8px;
  }

  .model-select {
    width: 100%;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.04);
    color: var(--text);
    padding: 8px 10px;
  }

  .chat-scroll {
    padding: 16px;
    overflow: auto;
    display: grid;
    gap: 14px;
  }

  .chat-footer {
    padding: 12px 16px 16px;
    border-top: 1px solid var(--line);
  }

  .output-card {
    display: inline-block;
    width: fit-content;
    max-width: 100%;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 8px 10px;
    background: rgba(255, 255, 255, 0.03);
  }

  .output-card p {
    margin: 0;
  }

  .preview-shell {
    display: grid;
    grid-template-columns: minmax(280px, 0.32fr) minmax(0, 1fr);
    min-height: 0;
    background: var(--panel-3);
  }

  .workbench-sidebar {
    display: grid;
    grid-template-rows: auto 1fr;
    min-height: 0;
    border-right: 1px solid var(--line);
    background: rgba(11, 17, 29, 0.94);
  }

  .workbench-sidebar-header {
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--line);
    display: grid;
    gap: 8px;
  }

  .workspace-path-form {
    display: grid;
    gap: 6px;
    min-width: 0;
  }

  .workspace-path-input {
    width: 100%;
    min-width: 0;
    border: 0;
    border-radius: 8px;
    padding: 6px 8px;
    color: var(--text);
    background: rgba(255, 255, 255, 0.03);
    font-size: 0.86rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    outline: none;
  }

  .workspace-path-input::placeholder {
    color: var(--dim);
  }

  .workspace-path-input:focus {
    background: rgba(124, 196, 255, 0.08);
    box-shadow: inset 0 0 0 1px rgba(124, 196, 255, 0.28);
  }

  .workbench-sidebar-body {
    padding: 10px 8px;
    overflow: auto;
    display: grid;
    gap: 12px;
  }

  .sidebar-section {
    display: grid;
    gap: 10px;
  }

  .sidebar-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .sidebar-section-head strong {
    color: var(--text);
    font-size: 0.78rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .file-tree {
    display: grid;
    gap: 2px;
  }

  .file-entry {
    width: 100%;
    text-align: left;
    border: 0;
    border-radius: 8px;
    padding: 6px 8px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 0.86rem;
  }

  .file-entry:hover,
  .file-entry-active {
    background: rgba(124, 196, 255, 0.08);
    color: var(--text);
  }

  .preview-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    background: rgba(18, 21, 28, 0.96);
  }

  .preview-topbar strong {
    font-size: 0.88rem;
    color: var(--text);
  }

  .preview-tabs {
    display: flex;
    gap: 8px;
  }

  .preview-tab {
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 6px 12px;
    background: rgba(255, 255, 255, 0.03);
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    transition:
      background 160ms ease,
      border-color 160ms ease,
      color 160ms ease;
  }

  .preview-tab:hover {
    border-color: var(--line-strong);
    color: var(--text);
  }

  .preview-tab-active {
    background: var(--accent-soft);
    color: var(--text);
    border-color: rgba(79, 140, 255, 0.5);
  }

  .preview-body {
    min-height: 0;
    padding: 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
  }

  .workspace-shell[data-view-mode="preview"] .preview-body {
    padding: 0;
    overflow: hidden;
  }

  .workspace-shell[data-view-mode="preview"] .preview-panel,
  .workspace-shell[data-view-mode="code"] .code-panel {
    display: grid;
  }

  .preview-panel,
  .code-panel {
    display: none;
    min-height: 0;
  }

  .preview-panel {
    height: 100%;
  }

  .preview-panel-runtime {
    overflow: hidden;
  }

  .preview-panel-review {
    height: auto;
    overflow: auto;
    align-content: start;
    padding: 16px;
    background: #11161d;
  }

  .eyebrow {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: #7ab8ff;
    font-weight: 600;
  }

  .workspace-rail,
  .file-rail {
    display: grid;
    grid-template-rows: 1fr;
    border-right: 1px solid var(--line);
    background: rgba(16, 19, 25, 0.94);
    min-height: 0;
  }

  .workspace-rail {
    padding: 18px 16px 16px;
  }

  .rail-scroll,
  .file-tree,
  .code-scroll,
  .terminal-body {
    overflow: auto;
  }

  .rail-scroll {
    padding-right: 4px;
  }

  .rail-accordion {
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--panel);
    margin-bottom: 14px;
    overflow: hidden;
  }

  .rail-accordion summary {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    cursor: pointer;
    list-style: none;
  }

  .rail-accordion summary::-webkit-details-marker {
    display: none;
  }

  .rail-accordion summary strong {
    display: block;
    color: var(--text);
    font-size: 0.95rem;
  }

  .rail-accordion[open] summary {
    background: rgba(255, 255, 255, 0.03);
    border-bottom: 1px solid var(--line);
  }

  .accordion-body {
    display: grid;
    gap: 12px;
    padding: 12px 14px 14px;
  }

  .rail-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .rail-summary {
    margin: 0;
    color: var(--dim);
    font-size: 0.85rem;
  }

  .rail-scroll h1,
  .panel-title,
  .card h3,
  .preview-pane h2,
  .diff-pane h2 {
    margin: 0;
    font-family: "Space Grotesk", "Segoe UI", sans-serif;
    letter-spacing: -0.04em;
  }

  .rail-scroll h1 {
    font-size: 1.04rem;
    line-height: 1.75;
    font-weight: 600;
    margin-bottom: 16px;
  }

  .rail-scroll p,
  .rail-scroll li,
  .card p {
    line-height: 1.7;
    font-size: 0.93rem;
  }

  .chat-stream {
    display: grid;
    gap: 12px;
  }

  .chat-row {
    display: grid;
    gap: 6px;
  }

  .chat-row-user {
    justify-items: end;
    text-align: right;
  }

  .chat-bubble {
    display: inline-block;
    width: fit-content;
    max-width: 100%;
    padding: 8px 10px;
    border-radius: 12px;
    border: 1px solid var(--line);
    background: var(--panel-2);
    color: var(--text);
    font-size: 0.9rem;
    line-height: 1.6;
  }

  .chat-bubble p {
    margin: 0;
  }

  .chat-bubble-user {
    background: rgba(79, 140, 255, 0.18);
    border-color: rgba(79, 140, 255, 0.32);
  }

  .chat-bubble-system {
    background: rgba(34, 197, 94, 0.12);
    border-color: rgba(34, 197, 94, 0.3);
  }

  .rail-scroll ul,
  .message-list,
  .option-list {
    margin: 10px 0 18px;
    padding-left: 18px;
  }

  .message-list,
  .option-list {
    list-style: none;
    padding: 0;
    display: grid;
    gap: 10px;
  }

  .message-list li,
  .option-list li {
    margin: 0;
  }

  .message-role {
    margin-bottom: 6px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #7ab8ff;
  }

  .task-card,
  .prompt-box,
  .card,
  .empty-state {
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--panel);
  }

  .dark-empty {
    background: #0f1319;
    color: var(--dim);
  }

  .task-card,
  .prompt-box,
  .card {
    padding: 14px;
  }

  .task-card {
    margin-top: 18px;
    background: linear-gradient(180deg, #1d2330 0%, #151920 100%);
  }

  .task-card .label {
    display: block;
    color: var(--text);
    font-weight: 600;
  }

  .task-card .meta {
    display: block;
    margin-top: 6px;
    font-size: 0.82rem;
    color: var(--dim);
  }

  .prompt-box {
    margin-top: 16px;
    background: #12161d;
  }

  .rail-grid {
    display: grid;
    gap: 12px;
  }

  .rail-meta-grid {
    display: grid;
    gap: 10px;
  }

  .rail-meta-grid strong {
    display: block;
    color: var(--text);
    margin-top: 4px;
  }

  .plan-list {
    list-style: none;
    padding: 0;
    margin: 10px 0 0;
    display: grid;
    gap: 10px;
  }

  .plan-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.03);
    font-size: 0.85rem;
  }

  .plan-title {
    color: var(--text);
  }

  .plan-status {
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.7rem;
  }

  .prompt-input {
    margin-top: 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.03);
    color: var(--dim);
  }

  .prompt-input input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--text);
    outline: none;
  }

  .send-button,
  .submit-button,
  .approval-button,
  .session-button {
    border: none;
    border-radius: 999px;
    cursor: pointer;
  }

  .send-button {
    margin-left: auto;
    width: 28px;
    height: 28px;
    background: var(--accent);
    color: white;
  }

  .prompt-footer,
  .pill-row {
    display: flex;
    align-items: center;
    gap: 10px;
    justify-content: space-between;
    flex-wrap: wrap;
    margin-top: 12px;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.04);
    color: var(--muted);
    font-size: 13px;
  }

  .file-rail {
    grid-template-rows: auto 1fr;
  }

  .file-topbar,
  .editor-topbar {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--line);
    background: rgba(18, 21, 28, 0.96);
    color: var(--muted);
    font-size: 0.9rem;
  }

  .file-topbar strong,
  .editor-topbar strong {
    color: var(--text);
  }

  .file-tree {
    padding: 12px 10px 16px;
  }

  .file-item,
  .editor-block-button,
  .timeline-action-button,
  .preview-block,
  .session-button {
    width: 100%;
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
    padding: 9px 10px;
  }

  .file-item {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--muted);
    font-size: 0.92rem;
  }

  .file-item-active,
  .selected-item,
  .preview-block-active {
    background: var(--accent-soft);
    border-color: rgba(79, 140, 255, 0.28);
    color: #dce8ff;
  }

  .editor-shell {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    min-height: 0;
    background: var(--panel-3);
  }

  .editor-split {
    display: grid;
    grid-template-columns: minmax(0, 1.05fr) minmax(360px, 0.95fr);
    min-height: 0;
  }

  .editor-pane {
    border-right: 1px solid var(--line);
    min-height: 0;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
  }

  .preview-pane {
    min-height: 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    background: #11161d;
  }

  .preview-pane-header,
  .diff-pane-header {
    padding: 14px 16px;
    border-bottom: 1px solid var(--line);
    background: rgba(18, 21, 28, 0.96);
  }

  .preview-pane-header p,
  .diff-pane-header p {
    margin: 0 0 6px;
  }

  .preview-pane-header h2,
  .diff-pane-header h2 {
    font-size: 1rem;
  }

  .code-view {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr);
    min-height: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 0.9rem;
    line-height: 1.8;
  }

  .line-numbers,
  .code-lines {
    margin: 0;
    padding: 16px 0;
    list-style: none;
  }

  .line-numbers {
    text-align: right;
    padding-right: 14px;
    color: #5f6b7b;
    border-right: 1px solid var(--line);
    background: #11141b;
  }

  .code-lines {
    padding-left: 18px;
    padding-right: 18px;
    color: #d7deea;
  }

  .code-line {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .browser-frame {
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    gap: 0;
  }

  .browser-toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--line);
    background: rgba(13, 20, 34, 0.92);
  }

  .browser-actions {
    display: flex;
    gap: 8px;
  }

  .browser-action {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    padding: 0;
  }

  .browser-action:hover {
    border-color: var(--line-strong);
    background: var(--accent-soft);
  }

  .browser-action:disabled {
    cursor: not-allowed;
    opacity: 0.42;
    color: var(--dim);
    background: rgba(255, 255, 255, 0.02);
    border-color: var(--line);
  }

  .browser-url-form {
    flex: 1;
  }

  .browser-url {
    width: 100%;
    min-width: 0;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 8px 12px;
    color: var(--text);
    background: #161c25;
    font-size: 0.85rem;
    outline: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .browser-url::placeholder {
    color: var(--dim);
  }

  .browser-url:focus {
    border-color: rgba(124, 196, 255, 0.4);
    box-shadow: 0 0 0 3px rgba(124, 196, 255, 0.08);
  }

  @media (prefers-reduced-motion: reduce) {
    .topbar-button,
    .preview-tab {
      transition: none;
    }

    .topbar-button:hover {
      transform: none;
    }
  }

  .browser-loading {
    height: 2px;
    background: rgba(255, 255, 255, 0.04);
    overflow: hidden;
  }

  .browser-loading span {
    display: block;
    width: 22%;
    height: 100%;
    background: linear-gradient(90deg, transparent, #7cc4ff, transparent);
    opacity: 0;
    transform: translateX(-120%);
  }

  .browser-loading-active span {
    opacity: 1;
    animation: browser-loading-slide 1s linear infinite;
  }

  @keyframes browser-loading-slide {
    from {
      transform: translateX(-120%);
    }

    to {
      transform: translateX(520%);
    }
  }

  .preview-frame {
    width: 100%;
    height: 100%;
    min-height: 0;
    border: 0;
    border-radius: 0;
    background: white;
  }

  .preview-stack {
    display: grid;
    gap: 8px;
  }

  .preview-block {
    display: grid;
    gap: 4px;
    border-color: var(--line);
    background: #161c25;
  }

  .preview-block-label {
    color: var(--text);
    font-weight: 600;
  }

  .preview-block-path {
    color: var(--dim);
    font-size: 0.82rem;
  }

  .diff-pane {
    border-top: 1px solid var(--line);
    background: #12161d;
    min-height: 0;
  }

  .diff-pane-body {
    padding: 14px;
    max-height: 260px;
    overflow: auto;
  }

  .empty-state {
    padding: 16px;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.03);
  }

  .dark-empty {
    background: #151920;
  }

  .field {
    display: grid;
    gap: 6px;
    color: var(--text);
  }

  .field input,
  .field textarea,
  .field select,
  .approval-reason-input {
    width: 100%;
    border: 1px solid var(--line-strong);
    border-radius: 12px;
    padding: 10px 12px;
    background: #11161d;
    color: var(--text);
  }

  .editor-form,
  .subgrid,
  .section-card,
  .stack {
    display: grid;
    gap: 12px;
  }

  .subgrid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .submit-button {
    justify-self: start;
    padding: 11px 16px;
    background: var(--accent);
    color: white;
  }

  .approval-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 12px;
  }

  .approve-button {
    padding: 10px 14px;
    background: #14532d;
    color: white;
  }

  .reject-button {
    padding: 10px 14px;
    background: #7f1d1d;
    color: white;
  }

  .approval-card,
  .approval-success-card,
  .approval-reject-card,
  .accent-card,
  .preview-detail,
  .diff-header {
    background: #151a23;
  }

  .terminal {
    display: grid;
    grid-template-rows: auto 1fr;
    min-height: 188px;
    border-top: 1px solid var(--line);
    background: #11141b;
  }

  .terminal-tabs {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
    color: var(--muted);
    font-size: 0.88rem;
  }

  .terminal-tab {
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.02);
  }

  .terminal-tab.active {
    color: var(--text);
    background: rgba(255, 255, 255, 0.06);
  }

  .terminal-tab-clear {
    margin-left: auto;
    padding: 2px 8px;
    border-radius: 5px;
    color: var(--muted);
    font-size: 0.75rem;
    opacity: 0.5;
    cursor: default;
  }

  .terminal-body {
    padding: 14px 16px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 0.86rem;
    line-height: 1.65;
    color: #b9c4d0;
  }

  .terminal-body p {
    margin: 0;
  }

  .terminal-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 8px;
    border-radius: 999px;
    background: var(--success);
  }

  .terminal-accent {
    color: #7ab8ff;
  }

  @media (max-width: 1120px) {
    .workspace-content {
      grid-template-columns: 1fr;
    }

    .chat-shell {
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }

    .preview-shell {
      grid-template-columns: 1fr;
    }

    .workbench-sidebar {
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }

    .preview-shell {
      min-height: 60vh;
    }

    .workspace-content,
    .editor-split {
      grid-template-columns: 1fr;
    }

    .subgrid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 720px) {
    .app-shell {
      height: 100vh;
      height: 100dvh;
      padding: 0;
    }

    .workspace-shell {
      height: 100vh;
      height: 100dvh;
      min-height: 100vh;
      border-radius: 0;
    }

    .workspace-topbar {
      flex-wrap: wrap;
    }

    .preview-topbar {
      flex-direction: column;
      align-items: flex-start;
    }

    .preview-tabs {
      width: 100%;
      flex-wrap: wrap;
    }
  }
`;

export function renderWebAppBody(input: WebAppBootstrap): string {
  const shell = createWebAppShell(input);
  const { workbench } = shell;
  const workspaceFileMap = new Map(
    (input.workspaceFiles ?? []).map((file) => [file.path, file.content]),
  );
  const uniqueFiles = [...new Set(workspaceFileMap.keys())];
  const activeFile =
    input.activeFile ??
    workbench.selectedBlockFile ??
    uniqueFiles[0] ??
    "apps/web/src/main.ts";
  const activeFileContent =
    workspaceFileMap.get(activeFile) ??
    `// ${activeFile}\n\nNo file content is available for this workspace path yet.`;
  const viewMode: ViewMode = input.viewMode ?? "preview";
  const previewMode: PreviewMode = input.previewMode ?? "runtime";
  const workspaceRoot = input.workspaceRoot ?? ".";

  return `
    <main class="app-shell">
      <div class="workspace-shell" data-view-mode="${escapeHtml(viewMode)}">
        <header class="workspace-topbar">
          <div class="topbar-left">
            <button class="brand-mark brand-home" data-go-home type="button" aria-label="Back to homepage">EZ</button>
            <div class="avatar">E</div>
            <div class="topbar-crumbs">
              <span class="topbar-title">${escapeHtml(shell.topBar.projectName)}</span>
              <span class="crumb-muted">🔒</span>
            </div>
          </div>
          <div class="topbar-right">
            <button class="topbar-button" data-open-dialog="sessions" type="button">Sessions</button>
            <button class="topbar-button" data-open-dialog="share" type="button">Share</button>
            <button class="topbar-button topbar-button-primary" data-open-dialog="publish" type="button">Publish</button>
            <div class="avatar">E</div>
          </div>
        </header>

        <section class="workspace-content">
          <aside class="chat-shell">
            <div class="chat-header">
              <div class="chat-title">
                <p class="eyebrow">Conversation</p>
                <h2>${escapeHtml(shell.topBar.projectName)}</h2>
                <p class="rail-summary">Runtime: ${escapeHtml(shell.topBar.runtimeType)}</p>
              </div>
              <div class="chat-tools">
                <label class="meta" for="model-select">Model</label>
                <select id="model-select" class="model-select">
                  <option value="gpt-4.1">gpt-4.1</option>
                  <option value="gpt-4.1-mini">gpt-4.1-mini</option>
                  <option value="claude-3.5">claude-3.5</option>
                  <option value="deepseek-r1">deepseek-r1</option>
                </select>
              </div>
            </div>
            <div class="chat-scroll">
              ${renderChatMessages(workbench)}
              ${renderModelOutput(workbench)}
            </div>
            <div class="chat-footer">
              <div class="prompt-box">
                <div class="meta">How can we help you today? (or /command)</div>
                <div class="prompt-input">
                  <span>+</span>
                  <input
                    data-command-input
                    value="${escapeHtml(input.composerText ?? "")}"
                    placeholder="Ask to refine layout, preview, or patch flow"
                  />
                  <span>${escapeHtml(shell.topBar.runtimeType)}</span>
                  <button class="send-button" data-send-message type="button" aria-label="Send">↑</button>
                </div>
              </div>
            </div>
          </aside>

          <section class="preview-shell">
            <aside class="workbench-sidebar">
              <div class="workbench-sidebar-header">
                <form class="workspace-path-form" data-workspace-path-form>
                  <p class="eyebrow">Workspace Path</p>
                  <input
                    class="workspace-path-input"
                    data-workspace-path-input
                    name="path"
                    value="${escapeHtml(workspaceRoot)}"
                    spellcheck="false"
                    autocomplete="off"
                  />
                </form>
              </div>
              <div class="workbench-sidebar-body">
                <section class="sidebar-section">
                  <div class="sidebar-section-head">
                    <strong>Filesystem</strong>
                  </div>
                  <div class="file-tree">
                    ${uniqueFiles
                      .map(
                        (filePath) => `
                          <button
                            type="button"
                            class="file-entry ${filePath === activeFile ? "file-entry-active" : ""}"
                            data-file-path="${escapeHtml(filePath)}"
                          >
                            ${escapeHtml(filePath)}
                          </button>
                        `,
                      )
                      .join("")}
                  </div>
                </section>
                <section class="sidebar-section">
                  <div class="sidebar-section-head">
                    <strong>Code</strong>
                  </div>
                  <div class="code-panel">
                    ${renderEditorCode(activeFileContent)}
                  </div>
                </section>
              </div>
            </aside>
            <section class="preview-body">
              <div class="preview-topbar">
                <div class="preview-tabs" role="tablist" aria-label="Workbench panel mode">
                  <button
                    class="preview-tab ${previewMode === "runtime" ? "preview-tab-active" : ""}"
                    data-preview-mode="runtime"
                    type="button"
                  >
                    Runtime Preview
                  </button>
                  <button
                    class="preview-tab ${previewMode === "review" ? "preview-tab-active" : ""}"
                    data-preview-mode="review"
                    type="button"
                  >
                    Code Review
                  </button>
                </div>
                <strong>${escapeHtml(activeFile)}</strong>
              </div>
              <div class="preview-panel ${previewMode === "runtime" ? "preview-panel-runtime" : "preview-panel-review"}">
                ${
                  previewMode === "runtime"
                    ? renderSessionPreview(workbench, {
                        ...(input.previewUrl ? { previewUrl: input.previewUrl } : {}),
                        ...(input.previewAddress ? { previewAddress: input.previewAddress } : {}),
                        ...(typeof input.previewCanGoBack === "boolean"
                          ? { canGoBack: input.previewCanGoBack }
                          : {}),
                        ...(typeof input.previewCanGoForward === "boolean"
                          ? { canGoForward: input.previewCanGoForward }
                          : {}),
                        ...(typeof input.previewLoading === "boolean"
                          ? { loading: input.previewLoading }
                          : {}),
                      })
                    : renderSelectedFileCode(activeFile, activeFileContent)
                }
              </div>
            </section>
          </section>
        </section>
      </div>
    </main>
  `;
}

export function renderWebAppDocument(input: WebAppBootstrap): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.config.projectName)} Workspace</title>
    <style>${webAppStyles}</style>
  </head>
  <body>${renderWebAppBody(input)}</body>
</html>`;
}

export function createWebAppShell(input: WebAppBootstrap) {
  return {
    topBar: {
      projectName: input.config.projectName,
      runtimeType: input.config.runtimeType,
    },
    centerPanels: centerWorkspacePanels,
    rightPanels: rightWorkbenchPanels,
    initialEvents: input.initialEvents,
    workbench: createWorkbenchViewModel(input),
  };
}
