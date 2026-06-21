import { bootstrapBlockEditDemo } from "@ezu/agent";
import { type AgentEvent } from "@ezu/protocol";

import {
  createInteractiveWebEditResponse,
  getWebEditorBlockFile,
  type InteractiveWebEditRequest,
  type WebAppBootstrap,
} from "./index";
import { getDefaultWorkspaceSnapshot } from "./workspace";

export interface DemoSessionDefinition {
  id: string;
  title: string;
  projectName: string;
  description: string;
  taskTitle: string;
  taskTimestamp: string;
  intent: string;
  properties: Array<{ key: string; label: string; value: string }>;
}

const demoSessions: DemoSessionDefinition[] = [
  {
    id: "club-promo",
    title: "Simple Webpage",
    projectName: "High School Club Promotion Page",
    description:
      "为高中社团宣传页生成一个深色、动效明显、适合移动端展示的单页网站，并把实现过程放进 IDE 风格的会话工作台里。",
    taskTitle: "Create High School Club Promotion Page",
    taskTimestamp: "Version 2 at Mar 22 2:18 PM",
    intent:
      "Refine the session workspace to feel closer to the project design system. Keep the project explanation on the left, show a code editor in the center, and preserve an embedded preview with a browser-container feel.",
    properties: [
      {
        key: "headline",
        label: "Headline",
        value: "High School Club Promotion Page",
      },
      {
        key: "status_focus",
        label: "Status Focus",
        value: "Code + preview + terminal",
      },
      {
        key: "style",
        label: "Style",
        value: "Dark product IDE",
      },
    ],
  },
  {
    id: "agency-redesign",
    title: "Agency Session",
    projectName: "Agency Site Rebuild",
    description:
      "围绕服务型网站改版，把需求、文件树、代码补丁和站点预览统一在一个持续会话里展示。",
    taskTitle: "Rebuild Agency Site Workspace",
    taskTimestamp: "Version 5 at Mar 25 9:08 PM",
    intent:
      "Show the redesign workflow as an active session page instead of a static homepage. The workbench should stay dense, dark, and review-friendly.",
    properties: [
      {
        key: "headline",
        label: "Headline",
        value: "Agency Site Rebuild",
      },
      {
        key: "status_focus",
        label: "Status Focus",
        value: "Session-first workspace",
      },
      {
        key: "style",
        label: "Style",
        value: "Operator console",
      },
    ],
  },
  {
    id: "portfolio-dash",
    title: "Portfolio Dashboard",
    projectName: "Personal Portfolio Tracker",
    description:
      "一个轻量的个人作品集仪表盘，展示项目卡片、技能标签和实时预览面板。",
    taskTitle: "Build Portfolio Dashboard Workspace",
    taskTimestamp: "Version 1 at Mar 28 11:42 AM",
    intent:
      "Create a clean dashboard layout with project cards, a skill tag cloud, and a live preview panel that reflects edits in real time.",
    properties: [
      {
        key: "headline",
        label: "Headline",
        value: "My Portfolio",
      },
      {
        key: "status_focus",
        label: "Status Focus",
        value: "Dashboard + preview",
      },
      {
        key: "style",
        label: "Style",
        value: "Clean minimal light",
      },
    ],
  },
];

export function listDemoSessions(): DemoSessionDefinition[] {
  return demoSessions;
}

export function getDemoSessionDefinition(sessionId: string): DemoSessionDefinition {
  return demoSessions.find((session) => session.id === sessionId) ?? demoSessions[0]!;
}

export async function createDemoBootstrap(sessionId = "club-promo"): Promise<WebAppBootstrap> {
  const definition = getDemoSessionDefinition(sessionId);
  const workspace = getDefaultWorkspaceSnapshot();

  const baseEvents: AgentEvent[] = [
    {
      type: "message.delta",
      messageId: `assistant-${definition.id}`,
      text: `已为 ${definition.projectName} 初始化会话工作台。`,
    },
    {
      type: "plan.updated",
      plan: [
        {
          id: `plan-${definition.id}-1`,
          title: "Summarize the user request",
          description: "Capture the design goals and constraints in the left conversation rail.",
          status: "completed",
        },
        {
          id: `plan-${definition.id}-2`,
          title: "Render the session workbench",
          description: "Show files, code editor, terminal, and embedded preview in one page.",
          status: "completed",
        },
        {
          id: `plan-${definition.id}-3`,
          title: "Keep preview tied to the active session",
          description: "Use the browser runtime stub so the session can expose a fast in-page preview.",
          status: "in_progress",
        },
      ],
    },
    {
      type: "action.created",
      action: {
        id: `action-${definition.id}-write`,
        source: "coder",
        action: {
          type: "file.write",
          path: "src/App.tsx",
          content: [
            "import { useState } from 'react';",
            "",
            "export function App() {",
            "  const [menuOpen, setMenuOpen] = useState(false);",
            "",
            "  return (",
            "    <main className='club-page'>",
            "      <section className='hero'>High School Club Promotion Page</section>",
            "    </main>",
            "  );",
            "}",
          ].join("\n"),
        },
        status: "completed",
        createdAt: "2026-03-25T04:00:00.000Z",
        updatedAt: "2026-03-25T04:00:00.000Z",
      },
    },
    {
      type: "file.changed",
      path: "src/App.tsx",
    },
    {
      type: "message.completed",
      messageId: `assistant-${definition.id}`,
    },
  ];

  const editRequest: InteractiveWebEditRequest = {
    selection: {
      blockId: "workbench",
      path: "section.workspace-shell",
    },
    intent: definition.intent,
    patchStrategy: "refine",
    properties: definition.properties,
  };

  const editResponse = createInteractiveWebEditResponse(editRequest);
  const webEditor = editResponse.nextState;
  const agentEvents = await bootstrapBlockEditDemo({
    sessionId: `${definition.id}-session`,
    projectId: `${definition.id}-project`,
    blockId: editRequest.selection.blockId,
    targetPath: getWebEditorBlockFile(editRequest.selection.blockId),
    suggestedPrompt: editResponse.suggestedPrompt,
  });
  const dropMessageIds = new Set(
    agentEvents
      .filter(
        (
          event,
        ): event is Extract<AgentEvent, { type: "message.delta" }> =>
          event.type === "message.delta" &&
          /Bolt|Planner is translating|Update page block/i.test(event.text),
      )
      .map((event) => event.messageId),
  );
  const cleanedAgentEvents = agentEvents.filter((event) => {
    if (event.type === "message.delta" || event.type === "message.completed") {
      return !dropMessageIds.has(event.messageId);
    }
    return true;
  });

  return {
    config: {
      projectName: definition.projectName,
      runtimeType: "browser",
    },
    initialEvents: [...baseEvents, ...cleanedAgentEvents],
    sessionId: `${definition.id}-session`,
    projectId: `${definition.id}-project`,
    workspaceRoot: workspace.rootPath,
    workspaceFiles: workspace.files,
    webEditor,
  };
}
