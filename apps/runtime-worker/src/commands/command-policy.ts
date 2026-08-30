export class CommandPolicyError extends Error {}

const maxArgvLength = 32;
const maxArgLength = 4_000;
const disallowedMetacharacters = [";", "&", "|", ">", "<", "$", "`", "\n", "\r"];

interface CommandAllowlistPolicy {
  executables: Record<string, "any" | string[]>;
}

const policies: Record<string, CommandAllowlistPolicy> = {
  "frontend-build": {
    executables: {
      pnpm: ["build", "test", "typecheck", "dev", "preview", "install"],
      npm: ["build", "test", "typecheck", "run", "install"],
      node: "any",
    },
  },
};

function assertNoMetacharactersOrControlChars(arg: string): void {
  if (arg.length > maxArgLength) {
    throw new CommandPolicyError(`argv entry exceeds the maximum length of ${maxArgLength} characters`);
  }
  for (const metacharacter of disallowedMetacharacters) {
    if (arg.includes(metacharacter)) {
      throw new CommandPolicyError(`argv entry must not contain the shell metacharacter ${JSON.stringify(metacharacter)}`);
    }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(arg)) {
    throw new CommandPolicyError("argv entry must not contain control characters");
  }
}

/**
 * Re-validates a command's argv against a named server-defined allowlist
 * policy. The worker never accepts a free-form shell string; only argv
 * arrays whose executable and (for some executables) first subcommand
 * appear in the policy are allowed to run.
 */
export function checkCommandPolicy(policyName: string, argv: string[]): void {
  const policy = policies[policyName];
  if (!policy) {
    throw new CommandPolicyError(`Unknown command policy: ${policyName}`);
  }

  if (!Array.isArray(argv) || argv.length === 0) {
    throw new CommandPolicyError("argv must be a non-empty array");
  }
  if (argv.length > maxArgvLength) {
    throw new CommandPolicyError(`argv must not exceed ${maxArgvLength} entries`);
  }
  for (const arg of argv) {
    if (typeof arg !== "string") {
      throw new CommandPolicyError("argv entries must be strings");
    }
    assertNoMetacharactersOrControlChars(arg);
  }

  const [executable, subcommand] = argv;
  const allowedSubcommands = policy.executables[executable!];
  if (allowedSubcommands === undefined) {
    throw new CommandPolicyError(`Executable ${executable} is not allowed by policy ${policyName}`);
  }
  if (allowedSubcommands !== "any" && (subcommand === undefined || !allowedSubcommands.includes(subcommand))) {
    throw new CommandPolicyError(`Subcommand ${subcommand} of ${executable} is not allowed by policy ${policyName}`);
  }
}
