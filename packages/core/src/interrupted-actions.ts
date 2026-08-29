import { type ActionState, type AgentEvent } from "@ezu/protocol";

// Pending actions may be intentionally waiting for user approval; only work
// that actually started can be considered interrupted by a restart.
const IN_PROGRESS_STATUSES: ReadonlySet<ActionState["status"]> = new Set(["running"]);

/**
 * Given the last known state of every action in a session, produces the events
 * needed to reconcile actions that were still in progress when the process
 * stopped (e.g. a server restart). Actions that already reached a terminal
 * status are left untouched.
 */
export function recoverInterruptedActions(actions: ActionState[]): AgentEvent[] {
  const timestamp = new Date().toISOString();
  const events: AgentEvent[] = [];

  for (const action of actions) {
    if (!IN_PROGRESS_STATUSES.has(action.status)) {
      continue;
    }

    const message = "Interrupted: the session was restarted before this action finished.";

    events.push({
      type: "action.updated",
      action: { ...action, status: "failed", error: message, updatedAt: timestamp },
    });
    events.push({
      type: "execution.error",
      code: "unknown",
      message,
      recoverable: true,
      actionId: action.id,
    });
  }

  return events;
}
