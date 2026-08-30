import type { RunAgentEventDto, RunMessageCompletedEvent, RunMessageDeltaEvent } from "../types";

export interface StreamingMessage {
  id: string;
  role: string;
  text: string;
  complete: boolean;
}

export interface RunStreamState {
  messages: StreamingMessage[];
  /** Set once a non-message event arrives, signalling the caller should refresh the session. */
  needsRefresh: boolean;
}

export function createRunStreamState(): RunStreamState {
  return { messages: [], needsRefresh: false };
}

export function applyRunEvent(state: RunStreamState, event: RunAgentEventDto): RunStreamState {
  if (event.type === "message.delta") {
    const delta = event as RunMessageDeltaEvent;
    const index = state.messages.findIndex((message) => message.id === delta.messageId);
    if (index === -1) {
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: delta.messageId, role: delta.role ?? "assistant", text: delta.text, complete: false },
        ],
      };
    }
    const messages = state.messages.slice();
    const current = messages[index]!;
    messages[index] = { ...current, text: current.text + delta.text };
    return { ...state, messages };
  }

  if (event.type === "message.completed") {
    const completed = event as RunMessageCompletedEvent;
    const messages = state.messages.map((message) =>
      message.id === completed.messageId ? { ...message, complete: true } : message,
    );
    return { ...state, messages };
  }

  return { ...state, needsRefresh: true };
}
