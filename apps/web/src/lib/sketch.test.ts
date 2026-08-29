import assert from "node:assert/strict";
import test from "node:test";

import {
  beginStroke,
  buildPrototypePrompt,
  clearSketch,
  EMPTY_SKETCH,
  extendStroke,
  undoStroke,
} from "./sketch.js";

test("undoing an empty sketch stays empty", () => {
  const next = undoStroke(EMPTY_SKETCH);

  assert.deepEqual(next, EMPTY_SKETCH);
});

test("undo removes the whole last stroke, keeping earlier strokes intact", () => {
  const oneStroke = beginStroke(EMPTY_SKETCH, { x: 0, y: 0 });
  const withSecondStroke = beginStroke(oneStroke, { x: 5, y: 5 });
  const extended = extendStroke(withSecondStroke, { x: 6, y: 6 });

  const afterUndo = undoStroke(extended);

  assert.equal(afterUndo.strokes.length, 1);
  assert.deepEqual(afterUndo, oneStroke);
});

test("extending a stroke appends a point to the current stroke only", () => {
  const started = beginStroke(EMPTY_SKETCH, { x: 1, y: 1 });

  const extended = extendStroke(started, { x: 2, y: 2 });

  assert.equal(extended.strokes.length, 1);
  assert.deepEqual(extended.strokes[0]?.points, [
    { x: 1, y: 1 },
    { x: 2, y: 2 },
  ]);
});

test("extending an empty sketch with no active stroke is a no-op", () => {
  const next = extendStroke(EMPTY_SKETCH, { x: 9, y: 9 });

  assert.deepEqual(next, EMPTY_SKETCH);
});

test("clearing a sketch discards every stroke", () => {
  const drawn = beginStroke(beginStroke(EMPTY_SKETCH, { x: 0, y: 0 }), { x: 1, y: 1 });

  const cleared = clearSketch(drawn);

  assert.deepEqual(cleared, EMPTY_SKETCH);
});

test("building a prototype prompt returns null when no strokes were drawn", () => {
  const prompt = buildPrototypePrompt(EMPTY_SKETCH, { width: 480, height: 320 });

  assert.equal(prompt, null);
});

test("building a prototype prompt describes the canvas size and stroke count", () => {
  const drawn = beginStroke(beginStroke(EMPTY_SKETCH, { x: 0, y: 0 }), { x: 1, y: 1 });

  const prompt = buildPrototypePrompt(drawn, { width: 480, height: 320 });

  assert.equal(
    prompt,
    "Use this scratch sketch as a rough layout reference: a 480x320px canvas with 2 hand-drawn strokes. " +
      "It is a manual wireframe hint, not machine-read artwork or an uploaded image. " +
      "No stroke geometry is included, so ask the user to describe the intended regions before proposing a prototype layout.",
  );
});
