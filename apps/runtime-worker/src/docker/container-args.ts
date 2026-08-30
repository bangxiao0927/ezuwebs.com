import type { RuntimeContainerSpec } from "./engine.js";

/**
 * Builds the flat argv for `docker create`. Never returns a shell string:
 * every element is a single argument, passed to `spawn` with `shell:
 * false`. This is where every hard security requirement for a runtime
 * container is enforced: fixed non-root user, no network, read-only root
 * filesystem, dropped capabilities, no new privileges, resource limits,
 * and tmpfs-only scratch space.
 */
export function buildCreateContainerArgs(spec: RuntimeContainerSpec): string[] {
  const workspaceMountFlags = spec.workspaceExec ? "nosuid,nodev,size=512m" : "noexec,nosuid,nodev,size=512m";

  const args: string[] = [
    "create",
    "--name",
    `ezu-runtime-${spec.runtimeId}`,
    "--user",
    "1000:1000",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    `${spec.pidsLimit}`,
    "--memory",
    `${spec.memoryBytes}`,
    "--cpus",
    `${spec.cpus}`,
    "--tmpfs",
    "/tmp:noexec,nosuid,nodev,size=64m",
    "--tmpfs",
    `/workspace:${workspaceMountFlags}`,
  ];

  for (const [key, value] of Object.entries(spec.labels)) {
    args.push("--label", `${key}=${value}`);
  }

  args.push(spec.image, "sleep", "infinity");

  return args;
}
