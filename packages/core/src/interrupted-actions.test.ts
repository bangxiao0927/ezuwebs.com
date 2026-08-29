import assert from "node:assert/strict";
import test from "node:test";

import { createTimelineAction } from "./index.js";
import { recoverInterruptedActions } from "./interrupted-actions.js";

test("recoverInterruptedActions leaves completed and cancelled actions untouched", () => {
  const completed = { ...createTimelineAction({ source: "coder", action: { type: "file.write", path: "a.html", content: "" } }), status: "completed" as const };
  const cancelled = { ...createTimelineAction({ source: "coder", action: { type: "file.write", path: "b.html", content: "" } }), status: "cancelled" as const };

  const events = recoverInterruptedActions([completed, cancelled]);

  assert.deepEqual(events, []);
});

test("recoverInterruptedActions marks a running action as failed and records an execution.error event", () => {
  const running = { ...createTimelineAction({ source: "coder", action: { type: "command.run", command: "pnpm build" } }), status: "running" as const };

  const events = recoverInterruptedActions([running]);

  assert.equal(events.length, 2);
  const [updateEvent, errorEvent] = events;
  assert.equal(updateEvent?.type, "action.updated");
  if (updateEvent?.type === "action.updated") {
    assert.equal(updateEvent.action.id, running.id);
    assert.equal(updateEvent.action.status, "failed");
    assert.ok(updateEvent.action.error);
  }
  assert.equal(errorEvent?.type, "execution.error");
  if (errorEvent?.type === "execution.error") {
    assert.equal(errorEvent.actionId, running.id);
    assert.equal(errorEvent.recoverable, true);
  }
});

test("recoverInterruptedActions leaves approval-pending actions untouched", () => {
  const pending = createTimelineAction({
    source: "coder",
    action: { type: "file.patch", path: "a.html", patch: "change" },
  });

  assert.deepEqual(recoverInterruptedActions([pending]), []);
});
