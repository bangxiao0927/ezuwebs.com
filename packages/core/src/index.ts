import {
  type ActionState,
  type AgentAction,
  type AgentEvent,
  type ConversationMessage,
  type PendingInteraction,
  type PlanStep,
  type RuntimePort,
  type RuntimeSnapshot,
  type SessionState,
} from "@ezu/protocol";

export {
  decideRecovery,
  type RecoveryDecision,
  type RecoveryPolicyInput,
  type RecoveryStrategy,
} from "./recovery.js";

export { recoverInterruptedActions } from "./interrupted-actions.js";

export interface RuntimeProcess {
  id: string;
  kill(): Promise<void>;
  onOutput(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
}

export interface RuntimeAdapter {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  patchFile(path: string, patch: string): Promise<void>;
  listFiles(root: string): Promise<string[]>;
  deleteFile(path: string): Promise<void>;
  runCommand(command: string, opts?: { cwd?: string }): Promise<RuntimeProcess>;
  openPreview(port?: number): Promise<RuntimePort>;
  watchFiles(cb: (event: { path: string; type: string }) => void): Promise<() => void>;
  watchPorts(
    cb: (event: { port: number; url: string; status: "open" | "close" }) => void,
  ): Promise<() => void>;
}

export interface SessionStore {
  get(id: string): SessionState | undefined;
  upsert(state: SessionState): void;
}

export function createSessionStore(): SessionStore {
  const sessions = new Map<string, SessionState>();

  return {
    get(id) {
      return sessions.get(id);
    },
    upsert(state) {
      sessions.set(state.id, state);
    },
  };
}

export function createEmptyRuntimeSnapshot(): RuntimeSnapshot {
  return {
    files: [],
    openPorts: [],
    activeCommands: [],
  };
}

export function createSessionState(input: Pick<SessionState, "id" | "projectId">): SessionState {
  const timestamp = new Date().toISOString();

  return {
    id: input.id,
    projectId: input.projectId,
    messages: [],
    plan: [],
    actions: [],
    runtime: createEmptyRuntimeSnapshot(),
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function upsertMessage(
  messages: ConversationMessage[],
  nextMessage: ConversationMessage,
): ConversationMessage[] {
  const index = messages.findIndex((message) => message.id === nextMessage.id);

  if (index === -1) {
    return [...messages, nextMessage];
  }

  return messages.map((message, currentIndex) =>
    currentIndex === index ? nextMessage : message,
  );
}

function upsertAction(actions: ActionState[], nextAction: ActionState): ActionState[] {
  const index = actions.findIndex((action) => action.id === nextAction.id);

  if (index === -1) {
    return [...actions, nextAction];
  }

  if (actions[index]!.status === "completed") {
    return actions;
  }

  return actions.map((action, currentIndex) => (currentIndex === index ? nextAction : action));
}

function markActionFailed(actions: ActionState[], actionId: string, error: string): ActionState[] {
  const index = actions.findIndex((action) => action.id === actionId);

  if (index === -1 || actions[index]!.status === "completed") {
    return actions;
  }

  return actions.map((action, currentIndex) =>
    currentIndex === index
      ? { ...action, status: "failed", error, updatedAt: new Date().toISOString() }
      : action,
  );
}

function createConversationMessage(id: string, role: ConversationMessage["role"], text: string): ConversationMessage {
  return {
    id,
    role,
    content: text,
    timestamp: new Date().toISOString(),
  };
}

function interactionFromAction(action: AgentAction): PendingInteraction | undefined {
  if (action.type === "interaction.choice") {
    return {
      type: "choice",
      id: crypto.randomUUID(),
      question: action.question,
      options: action.options,
    };
  }

  if (action.type === "interaction.confirm") {
    return {
      type: "confirm",
      id: crypto.randomUUID(),
      title: action.title,
      summary: action.summary,
    };
  }

  return undefined;
}

export function applyAgentEvent(session: SessionState, event: AgentEvent): SessionState {
  const updatedAt = new Date().toISOString();

  if (event.type === "message.delta") {
    const role = event.role ?? "assistant";
    const existing =
      session.messages.find((message) => message.id === event.messageId) ??
      createConversationMessage(event.messageId, role, "");

    return {
      ...session,
      messages: upsertMessage(session.messages, {
        ...existing,
        content: `${existing.content}${event.text}`,
        timestamp: updatedAt,
      }),
      updatedAt,
    };
  }

  if (event.type === "message.completed") {
    return {
      ...session,
      updatedAt,
    };
  }

  if (event.type === "plan.updated") {
    return {
      ...session,
      plan: event.plan,
      updatedAt,
    };
  }

  if (event.type === "action.created") {
    return {
      ...session,
      actions: upsertAction(session.actions, event.action),
      pendingInteraction:
        interactionFromAction(event.action.action) ?? session.pendingInteraction,
      updatedAt,
    };
  }

  if (event.type === "action.updated") {
    return {
      ...session,
      actions: upsertAction(session.actions, event.action),
      pendingInteraction:
        interactionFromAction(event.action.action) ?? session.pendingInteraction,
      updatedAt,
    };
  }

  if (event.type === "interaction.required") {
    return {
      ...session,
      pendingInteraction: event.interaction,
      updatedAt,
    };
  }

  if (event.type === "interaction.resolved") {
    const shouldClear = session.pendingInteraction?.id === event.interactionId;

    return {
      ...session,
      ...(shouldClear ? { pendingInteraction: undefined } : {}),
      updatedAt,
    };
  }

  if (event.type === "file.changed") {
    const nextFiles = new Set(session.runtime.files);
    nextFiles.add(event.path);

    return {
      ...session,
      runtime: {
        ...session.runtime,
        files: [...nextFiles].sort(),
      },
      updatedAt,
    };
  }

  if (event.type === "preview.ready") {
    const remainingPorts = session.runtime.openPorts.filter((port) => port.port !== event.port);
    const nextPort: RuntimePort = { port: event.port, url: event.url, status: "open" };

    return {
      ...session,
      runtime: {
        ...session.runtime,
        openPorts: [...remainingPorts, nextPort].sort((left, right) => left.port - right.port),
      },
      updatedAt,
    };
  }

  if (event.type === "execution.error") {
    return {
      ...session,
      actions: event.actionId
        ? markActionFailed(session.actions, event.actionId, event.message)
        : session.actions,
      updatedAt,
    };
  }

  if (event.type === "session.lifecycle") {
    return {
      ...session,
      status: event.status,
      updatedAt,
    };
  }

  return {
    ...session,
    updatedAt,
  };
}

export async function collectEventStream(
  session: SessionState,
  stream: AsyncIterable<AgentEvent>,
): Promise<{ session: SessionState; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  let nextSession = session;

  for await (const event of stream) {
    events.push(event);
    nextSession = applyAgentEvent(nextSession, event);
  }

  return {
    session: nextSession,
    events,
  };
}

export function createPlanStep(input: {
  id?: string;
  title: string;
  description?: string;
  status?: PlanStep["status"];
  requiresApproval?: boolean;
  tags?: string[];
}): PlanStep {
  return {
    id: input.id ?? crypto.randomUUID(),
    title: input.title,
    status: input.status ?? "pending",
    ...(input.description ? { description: input.description } : {}),
    ...(input.requiresApproval !== undefined
      ? { requiresApproval: input.requiresApproval }
      : {}),
    ...(input.tags?.length ? { tags: input.tags } : {}),
  };
}

export function createTimelineAction(input: {
  source: ActionState["source"];
  action: AgentAction;
}): ActionState {
  const timestamp = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    source: input.source,
    action: input.action,
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export interface Executor {
  enqueue(action: ActionState, opts?: ExecutorEnqueueOptions): Promise<ActionState>;
}

export interface ExecutorEnqueueOptions {
  maxRetries?: number;
}

export function createExecutor(input: {
  runtime: RuntimeAdapter;
  sessionStore: SessionStore;
}): Executor {
  return {
    async enqueue(action, opts) {
      const timestamp = new Date().toISOString();
      const maxRetries = opts?.maxRetries ?? 1;
      let lastError: unknown;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          if (action.action.type === "file.write") {
            await input.runtime.writeFile(action.action.path, action.action.content);
          }

          if (action.action.type === "file.patch") {
            await input.runtime.patchFile(action.action.path, action.action.patch);
          }

          if (action.action.type === "command.run") {
            await input.runtime.runCommand(
              action.action.command,
              action.action.cwd ? { cwd: action.action.cwd } : undefined,
            );
          }

          if (action.action.type === "preview.open") {
            await input.runtime.openPreview(action.action.port);
          }

          return {
            ...action,
            status: "completed",
            updatedAt: timestamp,
          };
        } catch (error) {
          lastError = error;
          if (attempt < maxRetries) continue;
        }
      }

      return {
        ...action,
        status: "failed",
        error: String(lastError),
        updatedAt: timestamp,
      };
    },
  };
}
