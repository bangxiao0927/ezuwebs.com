import assert from "node:assert/strict";
import { test } from "node:test";

import { RuntimeEventLog } from "./event-log.js";

test("append() assigns increasing sequence numbers and getSince() returns only newer events", () => {
  const log = new RuntimeEventLog();
  log.append({ type: "file.changed", path: "a.txt", changeType: "write" });
  log.append({ type: "port.changed", port: 4173, url: "https://p.example/x/", status: "open" });

  const fromStart = log.getSince(0);
  assert.equal(fromStart.events.length, 2);
  assert.equal(fromStart.nextSeq, 2);

  const fromMiddle = log.getSince(1);
  assert.equal(fromMiddle.events.length, 1);
  assert.equal(fromMiddle.events[0]?.type, "port.changed");
});
