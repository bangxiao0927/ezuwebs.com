import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCreateContainerArgs } from "./container-args.js";

const baseSpec = {
  runtimeId: "rt_abc123",
  image: "ezu/sandbox:frontend",
  labels: { "com.ezu.managed-by": "runtime-worker", "com.ezu.session-hash": "deadbeef" },
  memoryBytes: 512 * 1024 * 1024,
  cpus: 1,
  pidsLimit: 256,
  workspaceExec: false,
};

test("buildCreateContainerArgs never includes a shell, only a flat argv", () => {
  const args = buildCreateContainerArgs(baseSpec);
  assert.equal(Array.isArray(args), true);
  for (const arg of args) {
    assert.equal(typeof arg, "string");
  }
});

test("buildCreateContainerArgs drops privileges: fixed uid, no network, no capabilities, no new privileges", () => {
  const args = buildCreateContainerArgs(baseSpec);
  assert.ok(args.includes("--user"));
  assert.equal(args[args.indexOf("--user") + 1], "1000:1000");
  assert.ok(args.includes("--network"));
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--cap-drop"));
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  assert.ok(args.includes("--security-opt"));
  assert.ok(args.includes("no-new-privileges"));
});

test("buildCreateContainerArgs never mounts the docker socket, never uses host network or privileged mode", () => {
  const args = buildCreateContainerArgs(baseSpec);
  const joined = args.join(" ");
  assert.equal(joined.includes("docker.sock"), false);
  assert.equal(joined.includes("--privileged"), false);
  assert.equal(joined.includes("host"), false);
  assert.equal(args.includes("-v"), false);
  assert.equal(args.includes("--volume"), false);
  assert.equal(args.includes("--mount"), false);
});

test("buildCreateContainerArgs applies resource limits from the spec", () => {
  const args = buildCreateContainerArgs(baseSpec);
  assert.equal(args[args.indexOf("--memory") + 1], `${baseSpec.memoryBytes}`);
  assert.equal(args[args.indexOf("--cpus") + 1], `${baseSpec.cpus}`);
  assert.equal(args[args.indexOf("--pids-limit") + 1], `${baseSpec.pidsLimit}`);
});

test("buildCreateContainerArgs mounts /tmp and /workspace as tmpfs with noexec,nosuid,nodev by default", () => {
  const args = buildCreateContainerArgs(baseSpec);
  const tmpfsValues = args.filter((_, index) => args[index - 1] === "--tmpfs");
  const tmp = tmpfsValues.find((value) => value.startsWith("/tmp:"));
  const workspace = tmpfsValues.find((value) => value.startsWith("/workspace:"));
  assert.ok(tmp);
  assert.ok(workspace);
  assert.ok(tmp!.includes("noexec"));
  assert.ok(tmp!.includes("nosuid"));
  assert.ok(tmp!.includes("nodev"));
  assert.ok(workspace!.includes("noexec"));
  assert.ok(workspace!.includes("nosuid"));
  assert.ok(workspace!.includes("nodev"));
});

test("buildCreateContainerArgs allows exec on /workspace only when the profile explicitly requests it", () => {
  const args = buildCreateContainerArgs({ ...baseSpec, workspaceExec: true });
  const tmpfsValues = args.filter((_, index) => args[index - 1] === "--tmpfs");
  const workspace = tmpfsValues.find((value) => value.startsWith("/workspace:"));
  assert.ok(workspace);
  assert.equal(workspace!.includes("noexec"), false);
});

test("buildCreateContainerArgs carries every label and a deterministic name derived from the runtime id", () => {
  const args = buildCreateContainerArgs(baseSpec);
  assert.equal(args[args.indexOf("--name") + 1], `ezu-runtime-${baseSpec.runtimeId}`);
  for (const [key, value] of Object.entries(baseSpec.labels)) {
    assert.ok(args.includes("--label"));
    assert.ok(args.includes(`${key}=${value}`));
  }
});

test("buildCreateContainerArgs ends with the image and a sleep entrypoint, never a shell string", () => {
  const args = buildCreateContainerArgs(baseSpec);
  const imageIndex = args.indexOf(baseSpec.image);
  assert.ok(imageIndex > 0);
  assert.equal(args[imageIndex + 1], "sleep");
  assert.equal(args.some((arg) => arg.includes("&&") || arg.includes(";")), false);
});
