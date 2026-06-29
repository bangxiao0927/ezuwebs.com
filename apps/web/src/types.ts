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
  | { type: "confirm"; id: string; title: string; summary: string }
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
  status: "approved" | "rejected";
  title: string;
  summary: string;
  rejectionReason?: string;
  followUpStrategy?: "revise" | "replace_structure";
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
