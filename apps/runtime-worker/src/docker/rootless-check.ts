export class NotRootlessError extends Error {}

/**
 * Parses `docker info --format '{{json .}}'` output and throws unless
 * `SecurityOptions` lists `name=rootless`. Fails closed: unparseable output
 * is treated as "not confirmed rootless", never as "assume it's fine".
 */
export function assertRootlessFromDockerInfo(dockerInfoJson: string): void {
  let parsed: { SecurityOptions?: unknown };
  try {
    parsed = JSON.parse(dockerInfoJson) as { SecurityOptions?: unknown };
  } catch {
    throw new NotRootlessError("Could not parse `docker info` output to confirm the daemon is running rootless");
  }

  const securityOptions = Array.isArray(parsed.SecurityOptions) ? parsed.SecurityOptions : [];
  const isRootless = securityOptions.some(
    (option) => typeof option === "string" && option.split(",").includes("name=rootless"),
  );

  if (!isRootless) {
    throw new NotRootlessError(
      "The docker daemon does not report `name=rootless` in its SecurityOptions; refusing to start against a " +
        "rootful daemon. Set WORKER_REQUIRE_ROOTLESS=false only for an explicit, isolated local-dev override.",
    );
  }
}
