export interface SketchPoint {
  x: number;
  y: number;
}

export interface SketchStroke {
  points: SketchPoint[];
}

export interface SketchState {
  strokes: SketchStroke[];
}

export const EMPTY_SKETCH: SketchState = { strokes: [] };

export function beginStroke(state: SketchState, point: SketchPoint): SketchState {
  return { strokes: [...state.strokes, { points: [point] }] };
}

export function extendStroke(state: SketchState, point: SketchPoint): SketchState {
  if (state.strokes.length === 0) {
    return state;
  }
  const strokes = state.strokes.slice(0, -1);
  const current = state.strokes[state.strokes.length - 1] as SketchStroke;
  strokes.push({ points: [...current.points, point] });
  return { strokes };
}

export function undoStroke(state: SketchState): SketchState {
  if (state.strokes.length === 0) {
    return state;
  }
  return { strokes: state.strokes.slice(0, -1) };
}
export interface SketchCanvasSize {
  width: number;
  height: number;
}

export function clearSketch(_state: SketchState): SketchState {
  return EMPTY_SKETCH;
}

export function buildPrototypePrompt(state: SketchState, canvasSize: SketchCanvasSize): string | null {
  if (state.strokes.length === 0) {
    return null;
  }
  const strokeWord = state.strokes.length === 1 ? "stroke" : "strokes";
  return (
    `Use this scratch sketch as a rough layout reference: a ${canvasSize.width}x${canvasSize.height}px ` +
    `canvas with ${state.strokes.length} hand-drawn ${strokeWord}. ` +
    "It is a manual wireframe hint, not machine-read artwork or an uploaded image. " +
    "No stroke geometry is included, so ask the user to describe the intended regions before proposing a prototype layout."
  );
}
