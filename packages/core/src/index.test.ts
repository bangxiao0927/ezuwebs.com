import assert from "node:assert/strict";
import test from "node:test";

import { type ActionState } from "@ezu/protocol";

import { applyAgentEvent, createSessionState, createTimelineAction } from "./index.js";

test("createSessionState starts in the active lifecycle status", () => {
  const session = createSessionState({ id: "session-1", projectId: "project-1" });

  assert.equal(session.status, "active");
});

test("applyAgentEvent moves the session into the lifecycle status carried by session.lifecycle", () => {
  const session = createSessionState({ id: "session-1", projectId: "project-1" });

  const next = applyAgentEvent(session, {
    type: "session.lifecycle",
    status: "paused",
    reason: "Waiting on user approval",
  });

  assert.equal(next.status, "paused");
});

test("applyAgentEvent marks the targeted action as failed and keeps the error reason on execution.error", () => {
  const action = createTimelineAction({
    source: "coder",
    action: { type: "command.run", command: "pnpm build" },
  });
  const session = applyAgentEvent(createSessionState({ id: "session-1", projectId: "project-1" }), {
    type: "action.created",
    action,
  });

  const next = applyAgentEvent(session, {
    type: "execution.error",
    code: "command_failed",
    message: "pnpm build exited with code 1",
    recoverable: true,
    actionId: action.id,
  });

  const updated = next.actions.find((candidate) => candidate.id === action.id) as ActionState;
  assert.equal(updated.status, "failed");
  assert.equal(updated.error, "pnpm build exited with code 1");
});

test("a completed action is not overwritten by a later retry-shaped action.updated event", () => {
  const action = createTimelineAction({
    source: "coder",
    action: { type: "file.write", path: "index.html", content: "<html></html>" },
  });
  let session = applyAgentEvent(createSessionState({ id: "session-1", projectId: "project-1" }), {
    type: "action.created",
    action,
  });
  session = applyAgentEvent(session, {
    type: "action.updated",
    action: { ...action, status: "completed", updatedAt: new Date().toISOString() },
  });

  const staleRetry = applyAgentEvent(session, {
    type: "action.updated",
    action: { ...action, status: "pending", updatedAt: new Date().toISOString() },
  });

  const updated = staleRetry.actions.find((candidate) => candidate.id === action.id) as ActionState;
  assert.equal(updated.status, "completed");
});
