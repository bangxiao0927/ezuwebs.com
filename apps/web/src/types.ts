// Frontend DTOs mirroring the JSON contract exposed by @ezu/server.
// The frontend intentionally keeps its own types so it stays decoupled
// from the backend runtime packages.

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface PlanStep {
  id: string;
  title: string;
  description?: string;
  status: PlanStepStatus;
  requiresApproval?: boolean;
  tags?: string[];
}

export type ActionLifecycleStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

export interface AgentActionState {
  id: string;
  source: "planner" | "coder" | "reviewer" | "system";
  status: ActionLifecycleStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
  action: {
    type: string;
    path?: string;
    content?: string;
    patch?: string;
    command?: string;
    port?: number;
    title?: string;
    summary?: string;
    question?: string;
  };
}

export interface RuntimePort {
  port: number;
  url: string;
  status: "open" | "close";
  description?: string;
}

export type PendingInteraction =
  | { type: "choice"; id: string; question: string; options: Array<{ id: string; label: string; description?: string }> }
  | { type: "confirm"; id: string; title: string; summary: string; actionId?: string }
  | { type: "input"; id: string; label: string; placeholder?: string };

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

export interface InteractiveWebEditorState {
  selectedBlockId?: string;
  blocks: WebEditorBlock[];
  properties: WebEditorProperty[];
  lastIntent?: string;
  suggestedPrompt?: string;
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

export interface WorkbenchViewModel {
  chatMessages: Array<{ id: string; role: string; content: string }>;
  plan: PlanStep[];
  actions: AgentActionState[];
  pendingInteraction?: PendingInteraction;
  files: string[];
  previews: RuntimePort[];
  webEditor: InteractiveWebEditorState;
  selectedBlock?: WebEditorBlock;
  selectedBlockFile?: string;
  patchActions: AgentActionState[];
  selectedDiffAction?: AgentActionState;
  approvalDecision?: ApprovalDecisionState;
}

export interface SessionSummary {
  id: string;
  title: string;
  projectName: string;
  description: string;
  taskTitle: string;
  taskTimestamp: string;
}

export interface Session {
  id: string;
  definitionId: string;
  projectId: string;
  projectName: string;
  description: string;
  taskTitle: string;
  taskTimestamp: string;
  config: { projectName: string; runtimeType: "browser" | "remote" };
  workspaceRoot?: string;
  viewModel: WorkbenchViewModel;
}

export interface WorkspaceFile {
  path: string;
  content: string;
}

export type PatchStrategy = "replace" | "append" | "refine";
export type ApprovalDecision = "approved" | "rejected";

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  plan: string;
}

export interface DashboardProject {
  id: string;
  projectName: string;
  description: string;
  taskTitle: string;
  taskTimestamp: string;
}

export interface DashboardCounts {
  totalProjects: number;
}

export interface Dashboard {
  user: AuthUser;
  projects: DashboardProject[];
  counts: DashboardCounts;
}

export interface DevGrantPackage {
  id: string;
  label: string;
  credits: number;
}

export interface BillingSummary {
  balance: number;
  devGrantsEnabled: boolean;
  devGrantPackages: DevGrantPackage[];
}

export interface UsageEvent {
  id: string;
  kind: string;
  units: number;
  credits: number;
  model?: string;
  sessionId?: string;
  /**
   * "estimated" is a fixed reservation pending settlement, not a measured
   * token count; only "actual" reflects real model.usage tokens. The UI must
   * never present an estimated event as if it were actual.
   */
  metering: "actual" | "estimated";
  createdAt: string;
}

export interface UsagePage {
  events: UsageEvent[];
  total: number;
  totalCreditsConsumed: number;
  limit: number;
  offset: number;
}

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface RunDto {
  id: string;
  sessionId: string;
  status: RunStatus;
  lastEventSeq: number;
  error?: string;
}

export interface RunMessageDeltaEvent {
  type: "message.delta";
  messageId: string;
  text: string;
  role?: string;
}

export interface RunMessageCompletedEvent {
  type: "message.completed";
  messageId: string;
}

/**
 * A run's agent event, as carried by an SSE `event: agent` frame. Only
 * `message.delta`/`message.completed` are narrowly typed because the
 * conversation stream renders them live; every other event type is a
 * passthrough signal telling the caller to refresh the session instead.
 */
export type RunAgentEventDto =
  | RunMessageDeltaEvent
  | RunMessageCompletedEvent
  | ({ type: string } & Record<string, unknown>);

export interface RunEventDto {
  seq: number;
  event: RunAgentEventDto;
}
