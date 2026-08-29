<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

import {
  beginStroke,
  buildPrototypePrompt,
  clearSketch,
  EMPTY_SKETCH,
  extendStroke,
  type SketchState,
  undoStroke,
} from "../lib/sketch";

const emit = defineEmits<{ (event: "generate-prompt", prompt: string): void }>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const sketch = ref<SketchState>(EMPTY_SKETCH);
const activePointerId = ref<number | null>(null);
const logicalSize = ref({ width: 0, height: 0 });
let backingDpr = 1;

const strokeCount = () => sketch.value.strokes.length;

function pointFromEvent(event: PointerEvent): { x: number; y: number } {
  const canvas = canvasRef.value;
  if (!canvas) {
    return { x: 0, y: 0 };
  }
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function redraw(): void {
  const canvas = canvasRef.value;
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) {
    return;
  }
  ctx.save();
  ctx.setTransform(backingDpr, 0, 0, backingDpr, 0, 0);
  ctx.clearRect(0, 0, logicalSize.value.width, logicalSize.value.height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#1f2937";
  for (const stroke of sketch.value.strokes) {
    if (stroke.points.length === 0) {
      continue;
    }
    ctx.beginPath();
    const [first, ...rest] = stroke.points;
    ctx.moveTo(first!.x, first!.y);
    for (const point of rest) {
      ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function resizeCanvasToContainer(): void {
  const canvas = canvasRef.value;
  if (!canvas) {
    return;
  }
  const parent = canvas.parentElement;
  const width = parent?.clientWidth || canvas.clientWidth || 320;
  const height = 220;
  const dpr = window.devicePixelRatio || 1;
  backingDpr = dpr;
  logicalSize.value = { width, height };
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  redraw();
}

let resizeObserver: ResizeObserver | undefined;

onMounted(() => {
  resizeCanvasToContainer();
  window.addEventListener("resize", resizeCanvasToContainer);
  if (typeof ResizeObserver !== "undefined" && canvasRef.value?.parentElement) {
    resizeObserver = new ResizeObserver(() => resizeCanvasToContainer());
    resizeObserver.observe(canvasRef.value.parentElement);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener("resize", resizeCanvasToContainer);
});

function handlePointerDown(event: PointerEvent): void {
  const canvas = canvasRef.value;
  if (!canvas) {
    return;
  }
  canvas.setPointerCapture(event.pointerId);
  activePointerId.value = event.pointerId;
  sketch.value = beginStroke(sketch.value, pointFromEvent(event));
  redraw();
}

function handlePointerMove(event: PointerEvent): void {
  if (activePointerId.value !== event.pointerId) {
    return;
  }
  sketch.value = extendStroke(sketch.value, pointFromEvent(event));
  redraw();
}

function endStroke(event: PointerEvent): void {
  if (activePointerId.value !== event.pointerId) {
    return;
  }
  canvasRef.value?.releasePointerCapture(event.pointerId);
  activePointerId.value = null;
}

function handleClear(): void {
  sketch.value = clearSketch(sketch.value);
  redraw();
}

function handleUndo(): void {
  sketch.value = undoStroke(sketch.value);
  redraw();
}

function handleExportPng(): void {
  const canvas = canvasRef.value;
  if (!canvas || strokeCount() === 0) {
    return;
  }
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = "scratch-sketch.png";
  link.click();
}

function handleGeneratePrompt(): void {
  const prompt = buildPrototypePrompt(sketch.value, logicalSize.value);
  if (prompt) {
    emit("generate-prompt", prompt);
  }
}
</script>

<template>
  <article class="card drawing-scratch">
    <p class="eyebrow">Scratch sketch</p>
    <p class="scratch-disclaimer">
      Freehand notes only. Drawing here never edits code automatically; use "Generate prototype prompt" to
      turn it into an intent you can send to the agent yourself.
    </p>
    <div class="scratch-canvas-wrap">
      <canvas
        ref="canvasRef"
        class="scratch-canvas"
        role="img"
        aria-label="Scratch sketch canvas for freehand prototype notes"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="endStroke"
        @pointercancel="endStroke"
        @pointerleave="endStroke"
      ></canvas>
    </div>
    <div class="scratch-actions">
      <button type="button" class="secondary-button" @click="handleClear">Clear</button>
      <button type="button" class="secondary-button" :disabled="strokeCount() === 0" @click="handleUndo">
        Undo stroke
      </button>
      <button type="button" class="secondary-button" :disabled="strokeCount() === 0" @click="handleExportPng">
        Export PNG
      </button>
      <button
        type="button"
        class="secondary-button"
        :disabled="strokeCount() === 0"
        @click="handleGeneratePrompt"
      >
        Generate prototype prompt
      </button>
    </div>
  </article>
</template>
