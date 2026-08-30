import { RemoteRuntimeValidationError } from "./errors.js";

const disallowedMetacharacters = [";", "&", "|", ">", "<", "$", "`", "\n", "\r"];

export interface TokenizeCommandOptions {
  maxCommandLength?: number;
  maxArgvCount?: number;
}

const defaultMaxCommandLength = 4_000;
const defaultMaxArgvCount = 64;

/**
 * Turns a plain command string into an argv array without ever invoking a
 * shell. Rejects any shell metacharacter outright (even inside quotes)
 * rather than trying to emulate shell semantics for them.
 */
export function tokenizeCommand(command: string, options: TokenizeCommandOptions = {}): string[] {
  const maxCommandLength = options.maxCommandLength ?? defaultMaxCommandLength;
  const maxArgvCount = options.maxArgvCount ?? defaultMaxArgvCount;

  if (typeof command !== "string" || command.trim().length === 0) {
    throw new RemoteRuntimeValidationError("command must be a non-empty string");
  }

  if (command.length > maxCommandLength) {
    throw new RemoteRuntimeValidationError(`command must not exceed ${maxCommandLength} characters`);
  }

  for (const metacharacter of disallowedMetacharacters) {
    if (command.includes(metacharacter)) {
      throw new RemoteRuntimeValidationError(
        `command must not contain the shell metacharacter ${JSON.stringify(metacharacter)}`,
      );
    }
  }

  const argv: string[] = [];
  let current = "";
  let hasCurrent = false;
  let quote: '"' | "'" | undefined;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      hasCurrent = true;
      continue;
    }

    if (char === " " || char === "\t") {
      if (hasCurrent) {
        argv.push(current);
        current = "";
        hasCurrent = false;
      }
      continue;
    }

    current += char;
    hasCurrent = true;
  }

  if (quote) {
    throw new RemoteRuntimeValidationError("command has an unterminated quote");
  }
  if (hasCurrent) {
    argv.push(current);
  }

  if (argv.length === 0) {
    throw new RemoteRuntimeValidationError("command must contain at least one argument");
  }
  if (argv.length > maxArgvCount) {
    throw new RemoteRuntimeValidationError(`command must not exceed ${maxArgvCount} arguments`);
  }

  return argv;
}
