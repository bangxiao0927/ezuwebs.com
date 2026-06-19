export type WorkspacePanel =
  | "ChatPanel"
  | "PlanPanel"
  | "InteractionPanel"
  | "ActionTimeline"
  | "FileTree"
 | "EditorPanel"
 | "TerminalPanel"
 | "PreviewPanel"
  | "DiffPanel"
  | "SettingsPanel";

 export const centerWorkspacePanels: WorkspacePanel[] = [
   "ChatPanel",
  "PlanPanel",
  "InteractionPanel",
  "ActionTimeline",
];

export const rightWorkbenchPanels: WorkspacePanel[] = [
  "FileTree",
  "EditorPanel",
  "TerminalPanel",
   "PreviewPanel",
   "DiffPanel",
 ];
 
 export const bottomWorkbenchPanels: WorkspacePanel[] = [
   "SettingsPanel",
 ];

 export const workspacePanelLabels: Record<WorkspacePanel, string> = {
  ChatPanel: "Chat",
  PlanPanel: "Plan",
  InteractionPanel: "Interaction",
  ActionTimeline: "Timeline",
  FileTree: "Files",
  EditorPanel: "Editor",
  TerminalPanel: "Terminal",
   PreviewPanel: "Preview",
   DiffPanel: "Diff",
   SettingsPanel: "Settings",
 };
