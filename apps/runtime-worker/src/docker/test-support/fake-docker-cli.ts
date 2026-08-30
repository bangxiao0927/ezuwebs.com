import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A scripted stand-in for the `docker` binary itself: a real, separately
 * spawned process (unlike `FakeDockerEngine`, which never spawns anything),
 * used only to exercise `DockerCliEngine`'s own argv-building and
 * host-filesystem-safety logic without a real docker daemon.
 */
export interface FakeDockerResponse {
  /** Matches when these are a prefix of the actual argv this invocation received. */
  argv: string[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** Creates a symlink at the last argv entry (the `docker cp` destination) pointing at this target. */
  symlinkDestTo?: string;
  /** Writes this content to the last argv entry (the `docker cp` destination). */
  writeDestContent?: string;
}

export interface FakeDockerConfig {
  responses?: FakeDockerResponse[];
  default?: { exitCode?: number; stdout?: string; stderr?: string };
}

export interface FakeDockerCli {
  dockerBin: string;
  setConfig(config: FakeDockerConfig): Promise<void>;
  readInvocations(): Promise<string[][]>;
}

// Loaded via NODE_OPTIONS=--require, which only supports CommonJS, and runs
// before Node would otherwise try to load the fake docker argv's first
// element (e.g. "ps") as an entry script; calling process.exit() here stops
// that from ever happening. This sidesteps Windows' refusal to directly
// spawn a .cmd/.bat file without shell:true, while `dockerBin` stays a real
// executable (the node binary itself), matching how DockerCliEngine spawns
// the production docker binary.
const entryScriptSource = `
const { readFileSync, appendFileSync, symlinkSync, writeFileSync } = require("node:fs");
const { basename } = require("node:path");

// Before running any --require preload, Node resolves the would-be script
// argument (argv[1], i.e. this fake docker's subcommand) into an absolute
// path joined with cwd; every later argument is untouched. Undo that so the
// subcommand reads back as plain text (e.g. "ps"), matching what the real
// docker CLI would have received.
const argv = process.argv.slice(1);
if (argv.length > 0) {
  argv[0] = basename(argv[0]);
}
const logPath = process.env.FAKE_DOCKER_LOG;
if (logPath) {
  appendFileSync(logPath, JSON.stringify(argv) + "\\n");
}

const configPath = process.env.FAKE_DOCKER_CONFIG;
const config = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : {};

function matchesPrefix(prefix, actual) {
  return prefix.length <= actual.length && prefix.every((value, index) => value === actual[index]);
}

const responses = config.responses ?? [];
const found = responses.find((response) => matchesPrefix(response.argv, argv));
const chosen = found ?? config.default ?? {};

if (chosen.symlinkDestTo !== undefined) {
  symlinkSync(chosen.symlinkDestTo, argv[argv.length - 1]);
}
if (chosen.writeDestContent !== undefined) {
  writeFileSync(argv[argv.length - 1], chosen.writeDestContent);
}
if (chosen.stdout) {
  process.stdout.write(chosen.stdout);
}
if (chosen.stderr) {
  process.stderr.write(chosen.stderr);
}
process.exit(chosen.exitCode ?? 0);
`;

export async function createFakeDockerCli(): Promise<FakeDockerCli> {
  const dir = await mkdtemp(path.join(tmpdir(), "fake-docker-cli-"));
  const entryPath = path.join(dir, "fake-docker-entry.cjs");
  await writeFile(entryPath, entryScriptSource, "utf8");

  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, "{}", "utf8");
  const logPath = path.join(dir, "invocations.log");
  await writeFile(logPath, "", "utf8");

  // DockerCliEngine spawns dockerBin with no explicit `env`, so the child
  // inherits this process's environment; that is how these paths (and the
  // --require below) reach the fake docker entry script.
  process.env.FAKE_DOCKER_CONFIG = configPath;
  process.env.FAKE_DOCKER_LOG = logPath;
  // NODE_OPTIONS treats a backslash as an escape character even inside a
  // quoted string, which mangles a Windows path; forward slashes resolve
  // just as well and survive that parsing.
  process.env.NODE_OPTIONS = `--require "${entryPath.replaceAll("\\", "/")}"`;

  const dockerBin = process.execPath;

  return {
    dockerBin,
    async setConfig(config: FakeDockerConfig): Promise<void> {
      await writeFile(configPath, JSON.stringify(config), "utf8");
    },
    async readInvocations(): Promise<string[][]> {
      const raw = await readFile(logPath, "utf8");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as string[]);
    },
  };
}
