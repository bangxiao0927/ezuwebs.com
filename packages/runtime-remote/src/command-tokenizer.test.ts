import assert from "node:assert/strict";
import test from "node:test";

import { RemoteRuntimeValidationError } from "./errors.js";
import { tokenizeCommand } from "./command-tokenizer.js";

test("tokenizeCommand splits a plain command on whitespace", () => {
  assert.deepEqual(tokenizeCommand("pnpm install"), ["pnpm", "install"]);
});

test("tokenizeCommand collapses repeated whitespace", () => {
  assert.deepEqual(tokenizeCommand("pnpm   run    build"), ["pnpm", "run", "build"]);
});

test("tokenizeCommand honors double-quoted arguments containing spaces", () => {
  assert.deepEqual(tokenizeCommand('echo "hello world"'), ["echo", "hello world"]);
});

test("tokenizeCommand honors single-quoted arguments containing spaces", () => {
  assert.deepEqual(tokenizeCommand("echo 'hello world'"), ["echo", "hello world"]);
});

for (const metacharacter of [";", "&", "|", ">", "<", "$", "`", "\n", "\r"]) {
  test(`tokenizeCommand rejects the shell metacharacter ${JSON.stringify(metacharacter)}`, () => {
    assert.throws(
      () => tokenizeCommand(`pnpm build ${metacharacter} rm -rf /`),
      RemoteRuntimeValidationError,
    );
  });
}

test("tokenizeCommand rejects a blank command", () => {
  assert.throws(() => tokenizeCommand(""), RemoteRuntimeValidationError);
  assert.throws(() => tokenizeCommand("   "), RemoteRuntimeValidationError);
});

test("tokenizeCommand rejects a command longer than the configured limit", () => {
  assert.throws(
    () => tokenizeCommand(`echo ${"a".repeat(5000)}`, { maxCommandLength: 4000 }),
    RemoteRuntimeValidationError,
  );
});

test("tokenizeCommand rejects an argv with more entries than the configured limit", () => {
  const manyArgs = Array.from({ length: 65 }, (_, i) => `arg${i}`).join(" ");
  assert.throws(() => tokenizeCommand(manyArgs, { maxArgvCount: 64 }), RemoteRuntimeValidationError);
});

test("tokenizeCommand rejects an unterminated quote", () => {
  assert.throws(() => tokenizeCommand('echo "unterminated'), RemoteRuntimeValidationError);
});
