import assert from "node:assert/strict";
import { test } from "node:test";

import { NotRootlessError, assertRootlessFromDockerInfo } from "./rootless-check.js";

test("assertRootlessFromDockerInfo accepts docker info output listing the rootless security option", () => {
  const dockerInfoJson = JSON.stringify({ SecurityOptions: ["name=seccomp,profile=default", "name=rootless"] });
  assert.doesNotThrow(() => assertRootlessFromDockerInfo(dockerInfoJson));
});

test("assertRootlessFromDockerInfo rejects docker info output without the rootless security option", () => {
  const dockerInfoJson = JSON.stringify({ SecurityOptions: ["name=seccomp,profile=default"] });
  assert.throws(() => assertRootlessFromDockerInfo(dockerInfoJson), NotRootlessError);
});

test("assertRootlessFromDockerInfo rejects unparseable docker info output", () => {
  assert.throws(() => assertRootlessFromDockerInfo("not json"), NotRootlessError);
});
