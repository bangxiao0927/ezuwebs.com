import assert from "node:assert/strict";
import test from "node:test";

import { PausableClock, resolveThreadsRenderMode } from "./threadsAnimation.js";

test("webgl unavailable always falls back to the static gradient, regardless of motion preference", () => {
  assert.equal(
    resolveThreadsRenderMode({ webglAvailable: false, prefersReducedMotion: false }),
    "fallback",
  );
  assert.equal(
    resolveThreadsRenderMode({ webglAvailable: false, prefersReducedMotion: true }),
    "fallback",
  );
});

test("reduced motion with webgl available renders a single static frame", () => {
  assert.equal(
    resolveThreadsRenderMode({ webglAvailable: true, prefersReducedMotion: true }),
    "static",
  );
});

test("no reduced motion with webgl available animates continuously", () => {
  assert.equal(
    resolveThreadsRenderMode({ webglAvailable: true, prefersReducedMotion: false }),
    "animated",
  );
});

test("a running clock accumulates elapsed seconds from its start time", () => {
  const clock = new PausableClock(1_000, true);

  assert.equal(clock.elapsedSeconds(1_000), 0);
  assert.equal(clock.elapsedSeconds(3_500), 2.5);
});

test("pausing freezes elapsed time and resuming does not jump forward", () => {
  const clock = new PausableClock(1_000, true);

  clock.pause(2_000);
  assert.equal(clock.elapsedSeconds(2_000), 1);
  // A long real-world gap while paused (e.g. a hidden tab) must not count.
  assert.equal(clock.elapsedSeconds(60_000), 1);

  clock.resume(60_000);
  assert.equal(clock.elapsedSeconds(60_000), 1);
  assert.equal(clock.elapsedSeconds(60_500), 1.5);
});

test("a clock created while not running starts at zero elapsed seconds", () => {
  const clock = new PausableClock(500, false);

  assert.equal(clock.elapsedSeconds(10_000), 0);

  clock.resume(10_000);
  assert.equal(clock.elapsedSeconds(10_250), 0.25);
});

test("pausing an already-paused clock is a no-op", () => {
  const clock = new PausableClock(0, true);

  clock.pause(1_000);
  clock.pause(5_000);

  assert.equal(clock.elapsedSeconds(10_000), 1);
});

test("resuming an already-running clock is a no-op", () => {
  const clock = new PausableClock(0, true);

  clock.resume(5_000);

  assert.equal(clock.elapsedSeconds(10_000), 10);
});
