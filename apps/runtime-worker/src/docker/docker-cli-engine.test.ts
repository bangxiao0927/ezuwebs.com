import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DockerCliEngine } from "./docker-cli-engine.js";
import { createFakeDockerCli } from "./test-support/fake-docker-cli.js";

async function newScratchRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "docker-cli-engine-scratch-"));
}

test("listManagedContainers() requests --no-trunc and returns the full, unabbreviated container ID", async () => {
  const fakeCli = await createFakeDockerCli();
  const fullId = "a".repeat(64);
  await fakeCli.setConfig({
    responses: [
      {
        argv: ["ps"],
        stdout: `${JSON.stringify({ ID: fullId, Labels: "com.ezu.runtime-id=rt_1", State: "running" })}\n`,
      },
    ],
  });
  const engine = new DockerCliEngine({ dockerBin: fakeCli.dockerBin, scratchRoot: await newScratchRoot() });

  const containers = await engine.listManagedContainers();

  assert.equal(containers.length, 1);
  assert.equal(containers[0]?.containerId, fullId);

  const invocations = await fakeCli.readInvocations();
  const psInvocation = invocations.find((argv) => argv[0] === "ps");
  assert.ok(psInvocation?.includes("--no-trunc"));
});

test("readFile() rejects a container-supplied symlink instead of following it off the scratch root", async () => {
  const fakeCli = await createFakeDockerCli();
  const scratchRoot = await newScratchRoot();
  const secretPath = path.join(scratchRoot, "..", "host-secret.txt");
  await writeFile(secretPath, "top-secret-host-content", "utf8");

  await fakeCli.setConfig({
    responses: [{ argv: ["cp", "-L"], exitCode: 0, symlinkDestTo: secretPath }],
  });
  const engine = new DockerCliEngine({ dockerBin: fakeCli.dockerBin, scratchRoot });

  await assert.rejects(() => engine.readFile("container1", "escape.txt"));

  const stillSecret = await readFile(secretPath, "utf8");
  assert.equal(stillSecret, "top-secret-host-content");
});

test("readFile() returns the file's content when docker cp writes a plain regular file", async () => {
  const fakeCli = await createFakeDockerCli();
  const scratchRoot = await newScratchRoot();
  await fakeCli.setConfig({
    responses: [{ argv: ["cp", "-L"], exitCode: 0, writeDestContent: "hello from the container" }],
  });
  const engine = new DockerCliEngine({ dockerBin: fakeCli.dockerBin, scratchRoot });

  const content = await engine.readFile("container1", "index.html");

  assert.equal(content?.toString("utf8"), "hello from the container");
});

test("terminateContainer() stops then force-removes the container, never just the docker CLI client", async () => {
  const fakeCli = await createFakeDockerCli();
  const engine = new DockerCliEngine({ dockerBin: fakeCli.dockerBin, scratchRoot: await newScratchRoot() });

  await engine.terminateContainer("container1");

  const invocations = await fakeCli.readInvocations();
  assert.deepEqual(invocations[0], ["stop", "--time", "2", "container1"]);
  assert.deepEqual(invocations[1], ["rm", "--force", "container1"]);
});
