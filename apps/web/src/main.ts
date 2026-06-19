import {
  createWorkbenchViewModel,
  createInteractiveWebEditResponse,
  createInteractiveWebEditorState,
  getWebEditorBlockFile,
  renderWebAppBody,
  selectInteractiveWebEditorBlock,
  upsertInteractiveWebEditorProperty,
  webAppStyles,
  type InteractiveWebEditRequest,
  type PreviewMode,
  type ViewMode,
  type WebAppBootstrap,
} from "./index";
import { createReplacementPrompt } from "./replacement.js";
import { createDemoBootstrap, getDemoSessionDefinition, listDemoSessions } from "./demo";
import { type AgentEvent } from "@ezu/protocol";
import { getDefaultWorkspaceSnapshot } from "./workspace";

type DialogKind = "share" | "publish" | "sessions" | undefined;

type UiState = {
  activeDialog?: DialogKind;
  composerText: string;
  workspaceRoot?: string;
  activeFile?: string;
  viewMode: ViewMode;
  previewMode: PreviewMode;
  previewUrl?: string;
  previewAddress?: string;
  previewLoading?: boolean;
  toast?: string;
};

type PreviewHistoryState = {
  entries: string[];
  index: number;
};

const THREADS_VERTEX_SHADER = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const THREADS_FRAGMENT_SHADER = `
precision highp float;

uniform float iTime;
uniform vec3 iResolution;
uniform vec3 uColor;
uniform float uAmplitude;
uniform float uDistance;
uniform vec2 uMouse;

#define PI 3.1415926538

const int u_line_count = 18;
const float u_line_width = 3.0;
const float u_line_blur = 4.0;

float Perlin2D(vec2 P) {
    vec2 Pi = floor(P);
    vec4 Pf_Pfmin1 = P.xyxy - vec4(Pi, Pi + 1.0);
    vec4 Pt = vec4(Pi.xy, Pi.xy + 1.0);
    Pt = Pt - floor(Pt * (1.0 / 71.0)) * 71.0;
    Pt += vec2(26.0, 161.0).xyxy;
    Pt *= Pt;
    Pt = Pt.xzxz * Pt.yyww;
    vec4 hash_x = fract(Pt * (1.0 / 951.135664));
    vec4 hash_y = fract(Pt * (1.0 / 642.949883));
    vec4 grad_x = hash_x - 0.49999;
    vec4 grad_y = hash_y - 0.49999;
    vec4 grad_results = inversesqrt(grad_x * grad_x + grad_y * grad_y)
        * (grad_x * Pf_Pfmin1.xzxz + grad_y * Pf_Pfmin1.yyww);
    grad_results *= 1.4142135623730950;
    vec2 blend = Pf_Pfmin1.xy * Pf_Pfmin1.xy * Pf_Pfmin1.xy
               * (Pf_Pfmin1.xy * (Pf_Pfmin1.xy * 6.0 - 15.0) + 10.0);
    vec4 blend2 = vec4(blend, vec2(1.0 - blend));
    return dot(grad_results, blend2.zxzx * blend2.wwyy);
}

float pixel(float count, vec2 resolution) {
    return (1.0 / max(resolution.x, resolution.y)) * count;
}

float lineFn(vec2 st, float width, float perc, vec2 mouse, float time, float amplitude, float distance) {
    float split_offset = (perc * 0.4);
    float split_point = 0.1 + split_offset;

    float amplitude_normal = smoothstep(split_point, 0.7, st.x);
    float amplitude_strength = 0.5;
    float finalAmplitude = amplitude_normal * amplitude_strength
                           * amplitude * (1.0 + (mouse.y - 0.5) * 0.2);

    float time_scaled = time / 10.0 + (mouse.x - 0.5) * 1.0;
    float blur = smoothstep(split_point, split_point + 0.05, st.x) * perc;

    float xnoise = mix(
        Perlin2D(vec2(time_scaled, st.x + perc) * 2.5),
        Perlin2D(vec2(time_scaled, st.x + time_scaled) * 3.5) / 1.5,
        st.x * 0.3
    );

    float y = 0.5 + (perc - 0.5) * distance + xnoise / 2.0 * finalAmplitude;

    float line_start = smoothstep(
        y + (width / 2.0) + (u_line_blur * pixel(1.0, iResolution.xy) * blur),
        y,
        st.y
    );

    float line_end = smoothstep(
        y,
        y - (width / 2.0) - (u_line_blur * pixel(1.0, iResolution.xy) * blur),
        st.y
    );

    return clamp(
        (line_start - line_end) * (1.0 - smoothstep(0.0, 1.0, pow(perc, 0.3))),
        0.0,
        1.0
    );
}

void main() {
    vec2 uv = gl_FragCoord.xy / iResolution.xy;

    float line_strength = 1.0;
    for (int i = 0; i < u_line_count; i++) {
        float p = float(i) / float(u_line_count);
        line_strength *= (1.0 - lineFn(
            uv,
            u_line_width * pixel(1.0, iResolution.xy) * (1.0 - p),
            p,
            uMouse,
            iTime,
            uAmplitude,
            uDistance
        ));
    }

    float colorVal = 1.0 - line_strength;
    gl_FragColor = vec4(uColor * colorVal, colorVal);
}
`;

let cleanupLauncherEffects: (() => void) | undefined;

function createShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);

  if (!shader) {
    throw new Error("Failed to create shader.");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) ?? "Unknown shader compile error.";
    gl.deleteShader(shader);
    throw new Error(info);
  }

  return shader;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, THREADS_VERTEX_SHADER);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, THREADS_FRAGMENT_SHADER);
  const program = gl.createProgram();

  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error("Failed to create WebGL program.");
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) ?? "Unknown program link error.";
    gl.deleteProgram(program);
    throw new Error(info);
  }

  return program;
}

function mountLauncherThreads(target: HTMLElement): () => void {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    desynchronized: true,
    premultipliedAlpha: true,
    powerPreference: "high-performance",
  });

  if (!gl) {
    return () => {};
  }

  canvas.className = "launcher-threads-canvas";
  target.append(canvas);

  let program: WebGLProgram;

  try {
    program = createProgram(gl);
  } catch (error) {
    console.error(error);
    canvas.remove();
    return () => {};
  }

  const positionLocation = gl.getAttribLocation(program, "position");
  const timeLocation = gl.getUniformLocation(program, "iTime");
  const amplitudeLocation = gl.getUniformLocation(program, "uAmplitude");
  const colorLocation = gl.getUniformLocation(program, "uColor");
  const resolutionLocation = gl.getUniformLocation(program, "iResolution");
  const distanceLocation = gl.getUniformLocation(program, "uDistance");
  const mouseLocation = gl.getUniformLocation(program, "uMouse");

  const geometryBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, geometryBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );

  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  gl.useProgram(program);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);
  gl.uniform3f(colorLocation, 1, 1, 1);
  gl.uniform1f(amplitudeLocation, 1);
  gl.uniform1f(distanceLocation, 0);
  gl.uniform2f(mouseLocation, 0.5, 0.5);

  const resize = () => {
    const width = Math.max(1, Math.floor(target.clientWidth));
    const height = Math.max(1, Math.floor(target.clientHeight));
    const ratio = Math.min(window.devicePixelRatio || 1, 1.25);

    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform3f(resolutionLocation, canvas.width, canvas.height, canvas.width / canvas.height);
  };

  resize();
  const resizeObserver = new ResizeObserver(() => {
    resize();
  });
  resizeObserver.observe(target);
  window.addEventListener("resize", resize, { passive: true });

  let currentMouseX = 0.5;
  let currentMouseY = 0.5;
  let targetMouseX = 0.5;
  let targetMouseY = 0.5;

  const handleMouseMove = (event: PointerEvent) => {
    const rect = target.getBoundingClientRect();
    targetMouseX = (event.clientX - rect.left) / rect.width;
    targetMouseY = 1 - (event.clientY - rect.top) / rect.height;
  };

  const handleMouseLeave = () => {
    targetMouseX = 0.5;
    targetMouseY = 0.5;
  };

  target.addEventListener("pointermove", handleMouseMove, { passive: true });
  target.addEventListener("pointerleave", handleMouseLeave, { passive: true });

  let frameId = 0;
  let isVisible = true;
  const visibilityObserver = new IntersectionObserver((entries) => {
    isVisible = entries.some((entry) => entry.isIntersecting);
  });
  visibilityObserver.observe(target);

  const renderFrame = (now: number) => {
    frameId = requestAnimationFrame(renderFrame);
    if (document.hidden || !isVisible) {
      return;
    }
    gl.useProgram(program);
    currentMouseX += 0.1 * (targetMouseX - currentMouseX);
    currentMouseY += 0.1 * (targetMouseY - currentMouseY);
    gl.uniform2f(mouseLocation, currentMouseX, currentMouseY);
    gl.uniform1f(timeLocation, now * 0.001);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  frameId = requestAnimationFrame(renderFrame);

  return () => {
    cancelAnimationFrame(frameId);
    visibilityObserver.disconnect();
    resizeObserver.disconnect();
    window.removeEventListener("resize", resize);
    target.removeEventListener("pointermove", handleMouseMove);
    target.removeEventListener("pointerleave", handleMouseLeave);
    gl.deleteBuffer(geometryBuffer);
    gl.deleteProgram(program);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    canvas.remove();
  };
}

function ensureStyles(documentRef: Document): void {
  const existing = documentRef.getElementById("web-app-styles");

  if (existing) {
    existing.textContent = webAppStyles;
    return;
  }

  const style = documentRef.createElement("style");
  style.id = "web-app-styles";
  style.textContent = webAppStyles;
  documentRef.head.append(style);
}

function getSessionIdFromLocation(locationRef: Location): string | undefined {
  const hash = locationRef.hash.replace(/^#/, "");

  if (hash.startsWith("/session/")) {
    return hash.slice("/session/".length) || undefined;
  }

  const searchSession = new URLSearchParams(locationRef.search).get("session");
  return searchSession ?? undefined;
}

function setSessionHash(sessionId: string): void {
  if (location.hash !== `#/session/${sessionId}`) {
    location.hash = `/session/${sessionId}`;
  }
}

function goHome(): void {
  if (location.hash) {
    history.pushState("", document.title, `${location.pathname}${location.search}`);
  }
  void mount();
}

function normalizePreviewUrl(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return trimmed;
  }

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed) || trimmed.startsWith("/")) {
    return trimmed;
  }

  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(trimmed)) {
    return `http://${trimmed}`;
  }

  return `https://${trimmed}`;
}

function isUsablePreviewUrl(value: string | undefined): value is string {
  if (!value) {
    return false;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 && trimmed !== "about:blank";
}

function escapePreviewHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function inferPreviewLanguage(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase();

  if (!extension) {
    return "text";
  }

  if (extension === "ts" || extension === "tsx") {
    return "typescript";
  }

  if (extension === "js" || extension === "jsx") {
    return "javascript";
  }

  if (extension === "md") {
    return "markdown";
  }

  if (extension === "json") {
    return "json";
  }

  if (extension === "yml" || extension === "yaml") {
    return "yaml";
  }

  return extension;
}

function buildPreviewSummary(filePath: string, content: string): Array<{ label: string; value: string }> {
  const lines = content.length === 0 ? 0 : content.split("\n").length;
  const imports = countMatches(content, /^\s*import\s/mg);
  const exports = countMatches(content, /^\s*export\s/mg);
  const components = countMatches(content, /\bfunction\s+[A-Z]\w*|\bconst\s+[A-Z]\w*\s*=/g);

  return [
    { label: "Path", value: filePath },
    { label: "Language", value: inferPreviewLanguage(filePath) },
    { label: "Lines", value: String(lines) },
    { label: "Imports", value: String(imports) },
    { label: "Exports", value: String(exports) },
    { label: "Components", value: String(components) },
  ];
}

function buildRenderedPreview(filePath: string, content: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase();
  const trimmed = content.trim();

  if (extension === "html" || /^\s*<!doctype html>|^\s*<html[\s>]|^\s*<main[\s>]|^\s*<section[\s>]/i.test(trimmed)) {
    return content;
  }

  const title = filePath.split("/").pop() ?? filePath;
  const summary = buildPreviewSummary(filePath, content);
  const highlighted = content
    .split("\n")
    .slice(0, 14)
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: dark;
        --bg: #06101c;
        --panel: rgba(10, 19, 31, 0.9);
        --line: rgba(124, 196, 255, 0.18);
        --text: #f5f7fb;
        --muted: #8fa5c0;
        --accent: #7cc4ff;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(124, 196, 255, 0.18), transparent 24%),
          linear-gradient(180deg, #040812 0%, var(--bg) 100%);
      }
      main {
        min-height: 100vh;
        padding: 24px;
        display: grid;
        gap: 16px;
        align-content: start;
      }
      .hero,
      .panel {
        border: 1px solid var(--line);
        border-radius: 22px;
        background: var(--panel);
      }
      .hero {
        padding: 22px;
        display: grid;
        gap: 10px;
      }
      .eyebrow {
        margin: 0;
        color: var(--accent);
        font-size: 12px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      h1, h2, p, pre {
        margin: 0;
      }
      h1 {
        font-size: clamp(1.8rem, 4vw, 2.8rem);
        line-height: 0.94;
      }
      p {
        color: var(--muted);
        line-height: 1.6;
      }
      .summary {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
        gap: 10px;
      }
      .chip {
        padding: 12px 14px;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.03);
      }
      .chip strong,
      .chip span {
        display: block;
      }
      .chip strong {
        font-size: 0.74rem;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .chip span {
        margin-top: 8px;
        font-size: 0.95rem;
        color: var(--text);
        word-break: break-word;
      }
      .panel {
        overflow: hidden;
      }
      .browser-bar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--line);
      }
      .browser-dots {
        display: flex;
        gap: 8px;
      }
      .browser-dots span {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.3);
      }
      .browser-url {
        flex: 1;
        min-width: 0;
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid var(--line);
        color: var(--muted);
        background: rgba(255, 255, 255, 0.03);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      pre {
        padding: 18px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <p class="eyebrow">Runtime Preview</p>
        <h1>${escapePreviewHtml(title)}</h1>
        <p>This file is not directly renderable as HTML, so the preview surfaces structure and code context instead.</p>
        <div class="summary">
          ${summary
            .map(
              (item) => `
                <article class="chip">
                  <strong>${escapePreviewHtml(item.label)}</strong>
                  <span>${escapePreviewHtml(item.value)}</span>
                </article>
              `,
            )
            .join("")}
        </div>
      </section>
      <section class="panel">
        <div class="browser-bar">
          <div class="browser-dots"><span></span><span></span><span></span></div>
          <div class="browser-url">workspace://${escapePreviewHtml(filePath)}</div>
        </div>
        <pre>${escapePreviewHtml(highlighted)}</pre>
      </section>
    </main>
  </body>
</html>`;
}

function buildWorkspacePreviewDocument(filePath: string, content: string): string {
  const renderedPreview = buildRenderedPreview(filePath, content);
  const summary = buildPreviewSummary(filePath, content);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapePreviewHtml(filePath)}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #060816;
        --panel: rgba(13, 20, 34, 0.82);
        --panel-soft: rgba(11, 18, 30, 0.9);
        --line: rgba(171, 212, 255, 0.14);
        --text: #f5f7fb;
        --muted: #94a7c2;
        --accent: #7cc4ff;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: linear-gradient(180deg, #060816 0%, #09111d 100%);
        color: var(--text);
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      }
      main {
        min-height: 100vh;
        padding: 24px;
        display: grid;
        gap: 16px;
        align-content: start;
      }
      .layout {
        display: grid;
        gap: 16px;
        grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr);
      }
      .card {
        border: 1px solid var(--line);
        border-radius: 18px;
        background: var(--panel);
        padding: 20px;
      }
      .card-tight {
        padding: 0;
        overflow: hidden;
      }
      .eyebrow {
        margin: 0 0 8px;
        color: var(--accent);
        font-size: 12px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      h1, h2, p, pre { margin: 0; }
      h1 { font-size: 1.6rem; }
      h2 { font-size: 1rem; }
      p { color: var(--muted); line-height: 1.6; }
      .meta-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 10px;
        margin-top: 14px;
      }
      .meta-chip {
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.03);
      }
      .meta-chip strong,
      .meta-chip span {
        display: block;
      }
      .meta-chip strong {
        color: var(--muted);
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .meta-chip span {
        margin-top: 8px;
        color: var(--text);
        word-break: break-word;
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 16px 18px;
        border-bottom: 1px solid var(--line);
        background: var(--panel-soft);
      }
      .panel-head code {
        color: var(--muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .preview-stage {
        min-height: 460px;
        width: 100%;
        border: 0;
        background: white;
      }
      pre {
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px;
        line-height: 1.6;
      }
      .source {
        max-height: 560px;
        padding: 18px;
        background: rgba(8, 13, 22, 0.9);
      }
      @media (max-width: 900px) {
        .layout {
          grid-template-columns: 1fr;
        }
        .preview-stage {
          min-height: 320px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="card">
        <p class="eyebrow">Runtime Preview</p>
        <h1>${escapePreviewHtml(filePath)}</h1>
        <p>Preview generated from the current workspace file state, with a rendered surface and the underlying source side by side.</p>
        <div class="meta-grid">
          ${summary
            .map(
              (item) => `
                <div class="meta-chip">
                  <strong>${escapePreviewHtml(item.label)}</strong>
                  <span>${escapePreviewHtml(item.value)}</span>
                </div>
              `,
            )
            .join("")}
        </div>
      </section>
      <div class="layout">
        <section class="card card-tight">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Rendered Surface</p>
              <h2>workspace://${escapePreviewHtml(filePath)}</h2>
            </div>
            <code>live file snapshot</code>
          </div>
          <iframe
            class="preview-stage"
            srcdoc="${escapePreviewHtml(renderedPreview)}"
            title="${escapePreviewHtml(filePath)} rendered preview"
          ></iframe>
        </section>
        <section class="card card-tight">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Source</p>
              <h2>${escapePreviewHtml(filePath)}</h2>
            </div>
            <code>${escapePreviewHtml(inferPreviewLanguage(filePath))}</code>
          </div>
          <pre class="source">${escapePreviewHtml(content)}</pre>
        </section>
      </div>
    </main>
  </body>
</html>`;
}

function createWorkspacePreviewUrl(filePath: string, content: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    buildWorkspacePreviewDocument(filePath, content),
  )}`;
}

function renderSessionLauncher(): string {
  return `
    <main class="launcher-shell">
      <section class="launcher-hero">
        <div class="launcher-threads" data-launcher-threads></div>
        <button class="launcher-user-placeholder" type="button" aria-label="User Center">
          User Center
        </button>
        <div class="launcher-hero-copy">
          <p class="eyebrow">Threads Homepage</p>
          <h1>ezuwebs.com</h1>
          <p class="launcher-copy">
            AI based web IDE for building, previewing, and sharing web projects workspace. 
          </p>
          <p class="launcher-meta">
            Make your own websites easier.
          </p>
          <p class="launcher-shortcut-hint">Press <kbd>⌘K</kbd> or <kbd>Ctrl+K</kbd> to open the command palette.</p>
          <div class="launcher-actions">
            <button class="launcher-button launcher-button-primary" data-open-session="club-promo" type="button">Open Demo Session</button>
            <button class="launcher-button" data-open-session="agency-redesign" type="button">Open Agency Session</button>
          </div>
        </div>
      </section>
    </main>
  `;
}

function attachLauncherStyles(): void {
  const style = document.createElement("style");
  style.dataset.app = "launcher";
  style.textContent = `
    :root {
      color-scheme: dark;
      --launcher-text: #f5f7fb;
      --launcher-muted: #a8bad1;
      --launcher-meta: #565fe7;
      --launcher-border: rgba(171, 212, 255, 0.2);
      --launcher-panel: rgba(31, 43, 64, 0.34);
      --launcher-surface: rgba(39, 54, 79, 0.72);
      --launcher-accent: #8fd0ff;
      --launcher-shadow: 0 24px 90px rgba(0, 0, 0, 0.42);
    }

    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(143, 208, 255, 0.2), transparent 28%),
        linear-gradient(180deg, #10192a 0%, #162235 100%);
      color: var(--launcher-text);
      text-rendering: optimizeLegibility;
    }

    :where(button, a, input, textarea, select):focus {
      outline: none;
    }

    :where(button, a, input, textarea, select):focus-visible {
      outline: 2px solid rgba(143, 208, 255, 0.55);
      outline-offset: 3px;
    }

    .launcher-shell {
      min-height: 100vh;
      display: grid;
    }

    .launcher-card,
    .launcher-hero {
      position: relative;
      background: var(--launcher-panel);
    }

    .launcher-hero {
      display: grid;
      place-items: center;
      min-height: 100vh;
      padding: 0;
      overflow: hidden;
      background: radial-gradient(circle at center, rgba(58, 83, 118, 0.28), rgba(17, 27, 42, 0.88));
    }

    .launcher-threads {
      position: absolute;
      inset: 0;
    }

    .launcher-user-placeholder {
      position: absolute;
      top: 24px;
      right: 24px;
      z-index: 2;
      border: 1px solid rgba(171, 212, 255, 0.22);
      border-radius: 999px;
      background: rgba(29, 42, 63, 0.72);
      color: var(--launcher-text);
      padding: 10px 14px;
      font: inherit;
      letter-spacing: 0.04em;
      cursor: pointer;
      backdrop-filter: blur(12px);
    }

    .launcher-threads {
      opacity: 1;
    }

    .launcher-threads-canvas {
      width: 100%;
      height: 100%;
      display: block;
    }

    .launcher-hero-copy {
      display: grid;
      gap: 18px;
      position: relative;
      z-index: 1;
      width: min(960px, 100%);
      padding: 32px;
      text-align: center;
      justify-items: center;
    }

    .launcher-hero h1,
    .launcher-card h2 {
      margin: 0;
      font-family: "Space Grotesk", "Avenir Next", sans-serif;
      letter-spacing: -0.05em;
    }

    .launcher-hero h1 {
      font-size: clamp(4rem, 12vw, 8rem);
      line-height: 0.88;
    }

    .launcher-copy,
    .launcher-card p,
    .launcher-meta {
      color: var(--launcher-muted);
      line-height: 1.55;
      margin: 0;
    }

   .launcher-meta {
     color: var(--launcher-meta);
     line-height: 1.3;
     margin: 0;
   }

   .launcher-shortcut-hint {
     margin: 0;
     font-size: 0.82rem;
     color: var(--launcher-muted);
     opacity: 0.8;
   }

   .launcher-shortcut-hint kbd {
     padding: 1px 6px;
     border-radius: 5px;
     border: 1px solid var(--launcher-border);
     background: rgba(255, 255, 255, 0.08);
     font-family: inherit;
     font-size: 0.78rem;
   }

   .launcher-actions,
   .launcher-card-meta,
   .launcher-card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .launcher-actions {
      justify-content: center;
    }

    .launcher-chip {
      color: #d9ecff;
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    .launcher-card {
      border: 1px solid var(--launcher-border);
      border-radius: 18px;
      box-shadow: var(--launcher-shadow);
      backdrop-filter: blur(14px);
      padding: 22px;
      color: inherit;
      text-align: left;
      display: grid;
      gap: 14px;
      cursor: pointer;
      transition:
        transform 180ms ease,
        border-color 180ms ease,
        background 180ms ease;
    }

    .launcher-chip {
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(124, 196, 255, 0.08);
      border: 1px solid rgba(124, 196, 255, 0.18);
    }

    .launcher-card h2 {
      font-size: 1.35rem;
    }

    .launcher-card-meta {
      align-items: flex-start;
      color: var(--launcher-muted);
      font-size: 13px;
    }

    .launcher-button {
      border: 1px solid var(--launcher-border);
      border-radius: 999px;
      background: var(--launcher-surface);
      color: var(--launcher-text);
      padding: 12px 16px;
      cursor: pointer;
      font: inherit;
      transition:
        transform 180ms ease,
        border-color 180ms ease,
        background 180ms ease;
    }

    .launcher-button-primary {
      background: var(--launcher-accent);
      border-color: transparent;
      color: #08101d;
      font-weight: 650;
    }

    .launcher-button:hover,
    .launcher-card:hover {
      border-color: rgba(124, 196, 255, 0.28);
      transform: translateY(-2px);
    }

    .launcher-button:hover {
      background: rgba(124, 196, 255, 0.12);
    }

    @media (prefers-reduced-motion: reduce) {
      .launcher-button,
      .launcher-card {
        transition: none;
      }

      .launcher-button:hover,
      .launcher-card:hover {
        transform: none;
      }
    }

    .launcher-meta {
      font-size: 13px;
    }

    .eyebrow {
      margin: 0;
      color: rgba(255, 255, 255, 0.72);
      font-size: 12px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    @media (max-width: 980px) {
      .launcher-user-placeholder {
        top: 18px;
        right: 18px;
      }

      .launcher-hero-copy {
        padding: 24px;
      }
    }

    @media (max-width: 640px) {
      .launcher-user-placeholder {
        top: 14px;
        right: 14px;
        padding: 9px 12px;
      }

      .launcher-card {
        border-radius: 20px;
      }

      .launcher-hero-copy {
        padding: 18px;
      }

      .launcher-hero h1 {
        font-size: 3rem;
      }
    }
  `;
  document.head.append(style);
}

function clearEphemeralStyles(): void {
  for (const style of Array.from(document.head.querySelectorAll('style[data-app="launcher"]'))) {
    style.remove();
  }
}

function appendEvent(state: WebAppBootstrap, event: AgentEvent): WebAppBootstrap {
  return {
    ...state,
    initialEvents: [...state.initialEvents, event],
  };
}

async function copyText(text: string): Promise<boolean> {
  if (!navigator.clipboard) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function renderDialog(state: WebAppBootstrap, ui: UiState): string {
  if (!ui.activeDialog) {
    return ui.toast ? `<div class="workspace-toast">${ui.toast}</div>` : "";
  }

  const definition = getDemoSessionDefinition(getSessionIdFromLocation(window.location) ?? "club-promo");
  const shareUrl = `${window.location.origin}${window.location.pathname}#/session/${definition.id}`;

  let title = "";
  let body = "";
  let actions = "";

  if (ui.activeDialog === "share") {
    title = "Share Session";
    body = `
      <p>Copy the direct link to this active workspace session.</p>
      <div class="dialog-code">${shareUrl}</div>
    `;
    actions = `
      <button class="dialog-button dialog-button-primary" data-dialog-copy="${shareUrl}" type="button">Copy Link</button>
      <button class="dialog-button" data-close-dialog type="button">Close</button>
    `;
  } else if (ui.activeDialog === "publish") {
    title = "Publish Workspace";
    body = `
      <p>Publish the current session snapshot with the latest code, preview, and patch review state.</p>
      <ul class="dialog-list">
        <li>Project: ${definition.projectName}</li>
        <li>Actions: ${String(state.initialEvents.length)} tracked events</li>
        <li>Runtime: browser preview embedded</li>
      </ul>
    `;
    actions = `
      <button class="dialog-button dialog-button-primary" data-confirm-publish type="button">Publish Snapshot</button>
      <button class="dialog-button" data-close-dialog type="button">Cancel</button>
    `;
  } else if (ui.activeDialog === "sessions") {
    title = "Switch Session";
    body = `
      <p>Move between conversation workspaces without using the homepage as the editor surface.</p>
      <div class="dialog-session-grid">
        ${listDemoSessions()
          .map(
            (session) => `
              <button class="dialog-session-card" data-open-session="${session.id}" type="button">
                <strong>${session.title}</strong>
                <span>${session.taskTitle}</span>
              </button>
            `,
          )
          .join("")}
      </div>
    `;
    actions = `<button class="dialog-button" data-close-dialog type="button">Close</button>`;
  }

  return `
    <div class="workspace-dialog-backdrop" data-close-dialog>
      <div class="workspace-dialog" role="dialog" aria-modal="true" aria-label="${title}" onclick="event.stopPropagation()">
        <div class="workspace-dialog-head">
          <strong>${title}</strong>
          <button class="dialog-close" data-close-dialog type="button">×</button>
        </div>
        <div class="workspace-dialog-body">${body}</div>
        <div class="workspace-dialog-actions">${actions}</div>
      </div>
    </div>
    ${ui.toast ? `<div class="workspace-toast">${ui.toast}</div>` : ""}
  `;
}

function ensureWorkspaceUiStyles(): void {
  document.head.querySelector('style[data-app="workspace-ui"]')?.remove();
  const style = document.createElement("style");
  style.dataset.app = "workspace-ui";
  style.textContent = `
    .workspace-dialog-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(5, 8, 12, 0.72);
      display: grid;
      place-items: center;
      padding: 24px;
      z-index: 50;
    }

    .workspace-dialog {
      width: min(560px, 100%);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 20px;
      background: #141922;
      color: #edf2ff;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.42);
    }

    .workspace-dialog-head,
    .workspace-dialog-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 18px;
    }

    .workspace-dialog-body {
      padding: 0 18px 18px;
      color: #9aa4b2;
      line-height: 1.7;
    }

    .dialog-close,
    .dialog-button,
    .dialog-session-card {
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.04);
      color: inherit;
      cursor: pointer;
    }

    .dialog-close {
      width: 32px;
      height: 32px;
      border-radius: 999px;
    }

    .dialog-button {
      border-radius: 999px;
      padding: 10px 14px;
    }

    .dialog-button-primary {
      background: #4f8cff;
      border-color: transparent;
      color: white;
    }

    .dialog-code {
      margin-top: 14px;
      padding: 12px 14px;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: #0f1319;
      color: #dce8ff;
      word-break: break-all;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
    }

    .dialog-list {
      margin: 14px 0 0;
      padding-left: 18px;
    }

    .dialog-session-grid {
      display: grid;
      gap: 12px;
      margin-top: 14px;
    }

    .dialog-session-card {
      width: 100%;
      text-align: left;
      border-radius: 14px;
      padding: 14px;
      display: grid;
      gap: 6px;
    }

    .dialog-session-card strong {
      color: #edf2ff;
    }

    .dialog-session-card span {
      color: #9aa4b2;
      font-size: 13px;
    }

    .workspace-toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: #141922;
      color: #edf2ff;
      z-index: 60;
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.32);
    }
  `;
  document.head.append(style);
}

function attachLauncherListeners(target: HTMLElement): void {
  for (const button of Array.from(target.querySelectorAll<HTMLButtonElement>("[data-open-session]"))) {
    button.addEventListener("click", () => {
      const nextId = button.dataset.openSession;

      if (nextId) {
        setSessionHash(nextId);
      }
    });
  }

  const threadsTarget = target.querySelector<HTMLElement>("[data-launcher-threads]");

  cleanupLauncherEffects?.();
  cleanupLauncherEffects = threadsTarget ? mountLauncherThreads(threadsTarget) : undefined;
}

async function mountSessionApp(target: HTMLElement, sessionId: string): Promise<void> {
  const bootstrap = await createDemoBootstrap(sessionId);
  let state = bootstrap;
  const defaultWorkspace = getDefaultWorkspaceSnapshot();
  let uiState: UiState = {
    composerText: state.composerText ?? "",
    workspaceRoot: state.workspaceRoot ?? defaultWorkspace.rootPath,
    viewMode: "preview",
    previewMode: state.previewMode ?? "runtime",
  };
  let previewHistory: PreviewHistoryState = {
    entries: [],
    index: -1,
  };

  const buildWorkspaceFiles = () => {
    const files = new Map(
      (state.workspaceFiles ?? defaultWorkspace.files).map((file) => [file.path, file.content]),
    );
    const workbench = createWorkbenchViewModel(state);

    for (const action of workbench.actions) {
      if (action.action.type === "file.write") {
        files.set(action.action.path, action.action.content);
      }

      if (action.action.type === "file.patch") {
        files.set(action.action.path, action.action.patch);
      }
    }

    if (workbench.selectedBlockFile && workbench.selectedBlock?.html) {
      files.set(workbench.selectedBlockFile, workbench.selectedBlock.html);
    }

    if (!files.has("apps/web/src/index.ts") && workbench.webEditor.suggestedPrompt) {
      files.set("apps/web/src/index.ts", workbench.webEditor.suggestedPrompt);
    }

    return files;
  };

  const syncActiveFileSelection = () => {
    const files = buildWorkspaceFiles();
    const activePath =
      uiState.activeFile ??
      state.activeFile ??
      createWorkbenchViewModel(state).selectedBlockFile ??
      [...files.keys()][0] ??
      "apps/web/src/main.ts";

    uiState = {
      ...uiState,
      activeFile: activePath,
    };
  };

  const getDefaultPreviewUrl = (): string | undefined => {
    const latestPreviewEvent = [...state.initialEvents]
      .reverse()
      .find(
        (
          event,
        ): event is Extract<AgentEvent, { type: "preview.ready" }> =>
          event.type === "preview.ready",
      );

    return latestPreviewEvent?.url;
  };

  const syncPreviewHistory = (nextUrl?: string) => {
    const resolvedUrl = nextUrl ?? uiState.previewUrl ?? getDefaultPreviewUrl();

    if (!isUsablePreviewUrl(resolvedUrl)) {
      return;
    }

    if (previewHistory.index >= 0 && previewHistory.entries[previewHistory.index] === resolvedUrl) {
      uiState = {
        ...uiState,
        previewUrl: resolvedUrl,
        previewAddress: resolvedUrl,
      };
      return;
    }

    const existingIndex = previewHistory.entries.lastIndexOf(resolvedUrl);
    if (existingIndex >= 0) {
      previewHistory = {
        entries: previewHistory.entries,
        index: existingIndex,
      };
    } else {
      previewHistory = {
        entries: [...previewHistory.entries.slice(0, previewHistory.index + 1), resolvedUrl],
        index: previewHistory.index + 1,
      };
    }

    uiState = {
      ...uiState,
      previewUrl: resolvedUrl,
      previewAddress: resolvedUrl,
    };
  };

  const render = () => {
    syncActiveFileSelection();
    syncPreviewHistory();
    state = {
      ...state,
      composerText: uiState.composerText,
    };
    const renderState: WebAppBootstrap = {
      ...state,
      ...(uiState.workspaceRoot ? { workspaceRoot: uiState.workspaceRoot } : {}),
      workspaceFiles: [...buildWorkspaceFiles()].map(([path, content]) => ({ path, content })),
      viewMode: uiState.viewMode,
      previewMode: uiState.previewMode,
      ...(uiState.activeFile ? { activeFile: uiState.activeFile } : {}),
      ...(uiState.previewUrl ? { previewUrl: uiState.previewUrl } : {}),
      ...(uiState.previewAddress ? { previewAddress: uiState.previewAddress } : {}),
      ...(typeof uiState.previewLoading === "boolean"
        ? { previewLoading: uiState.previewLoading }
        : {}),
      previewCanGoBack: previewHistory.index > 0,
      previewCanGoForward: previewHistory.index >= 0 && previewHistory.index < previewHistory.entries.length - 1,
    };
    target.innerHTML = `${renderWebAppBody(renderState)}${renderDialog(state, uiState)}`;

    for (const button of Array.from(target.querySelectorAll<HTMLButtonElement>("[data-block-id]"))) {
      button.addEventListener("click", () => {
        state = {
          ...state,
          webEditor: selectInteractiveWebEditorBlock(
            createInteractiveWebEditorState(state.webEditor),
            button.dataset.blockId ?? "",
          ),
        };
        render();
      });
    }

    for (const button of Array.from(target.querySelectorAll<HTMLButtonElement>("[data-preview-block-id]"))) {
      button.addEventListener("click", () => {
        state = {
          ...state,
          webEditor: selectInteractiveWebEditorBlock(
            createInteractiveWebEditorState(state.webEditor),
            button.dataset.previewBlockId ?? "",
          ),
        };
        render();
      });
    }

    for (const button of Array.from(target.querySelectorAll<HTMLButtonElement>("[data-diff-action-id]"))) {
      button.addEventListener("click", () => {
        const id = button.dataset.diffActionId;
        const filePath = button.dataset.filePath;

        state = {
          ...state,
          ...(id ? { selectedDiffActionId: id } : {}),
        };
        if (filePath) {
          uiState = {
            ...uiState,
            activeFile: filePath,
          };
        }
        render();
      });
    }

    for (const button of Array.from(target.querySelectorAll<HTMLButtonElement>("[data-toolbar-action]"))) {
      button.addEventListener("click", () => {
        const mode = button.dataset.toolbarAction as ViewMode | undefined;

        if (!mode) {
          return;
        }

        uiState = {
          ...uiState,
          viewMode: mode,
        };
        render();
      });
    }

    for (const button of Array.from(target.querySelectorAll<HTMLButtonElement>("[data-preview-mode]"))) {
      button.addEventListener("click", () => {
        const mode = button.dataset.previewMode as PreviewMode | undefined;

        if (!mode || mode === uiState.previewMode) {
          return;
        }

        uiState = {
          ...uiState,
          previewMode: mode,
        };
        render();
      });
    }

    for (const button of Array.from(target.querySelectorAll<HTMLButtonElement>("[data-file-path]"))) {
      button.addEventListener("click", () => {
        if (button.dataset.diffActionId) {
          return;
        }
        const filePath = button.dataset.filePath;

        if (!filePath) {
          return;
        }

        uiState = {
          ...uiState,
          activeFile: filePath,
        };
        render();
      });
    }

    const previewFrame = target.querySelector<HTMLIFrameElement>("[data-preview-frame]");
    const previewUrlInput = target.querySelector<HTMLInputElement>("[data-preview-url-input]");
    const workspacePathInput = target.querySelector<HTMLInputElement>("[data-workspace-path-input]");

    previewFrame?.addEventListener("load", () => {
      let nextUrl = previewFrame.src;

      try {
        previewFrame.contentWindow?.scrollTo(0, 0);
      } catch {
        // Ignore cross-origin or unavailable scroll access.
      }

      try {
        nextUrl = previewFrame.contentWindow?.location.href ?? nextUrl;
      } catch {
        nextUrl = previewFrame.src;
      }

      const normalized = normalizePreviewUrl(nextUrl);
      if (!isUsablePreviewUrl(normalized)) {
        uiState = {
          ...uiState,
          previewLoading: false,
        };
        return;
      }

      const currentEntry = previewHistory.entries[previewHistory.index];
      if (currentEntry !== normalized) {
        previewHistory = {
          entries: [...previewHistory.entries.slice(0, previewHistory.index + 1), normalized],
          index: previewHistory.index + 1,
        };
      }

      const shouldRender =
        uiState.previewLoading !== false || uiState.previewUrl !== normalized;

      uiState = {
        ...uiState,
        previewLoading: false,
      };

      if (shouldRender) {
        render();
      }
    });

    target.querySelector<HTMLFormElement>("[data-preview-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const nextUrl = normalizePreviewUrl(previewUrlInput?.value ?? "");

      if (!nextUrl) {
        return;
      }

      previewHistory = {
        entries: [...previewHistory.entries.slice(0, previewHistory.index + 1), nextUrl],
        index: previewHistory.index + 1,
      };
      uiState = {
        ...uiState,
        previewUrl: nextUrl,
        previewAddress: nextUrl,
        previewLoading: true,
      };
      render();
    });

    target.querySelector<HTMLFormElement>("[data-workspace-path-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const nextPath = workspacePathInput?.value.trim();

      if (!nextPath) {
        return;
      }

      uiState = {
        ...uiState,
        workspaceRoot: nextPath,
      };
      render();
    });

    for (const button of Array.from(target.querySelectorAll<HTMLButtonElement>("[data-preview-nav]"))) {
      const action = button.dataset.previewNav;
      const disabled =
        (action === "back" && previewHistory.index <= 0) ||
        (action === "forward" && previewHistory.index >= previewHistory.entries.length - 1);

      button.disabled = disabled;

      button.addEventListener("click", () => {
        if (action === "back") {
          if (previewHistory.index <= 0) {
            return;
          }

          previewHistory = {
            ...previewHistory,
            index: previewHistory.index - 1,
          };
          const nextPreviewUrl = previewHistory.entries[previewHistory.index];
          uiState = {
            ...uiState,
            ...(nextPreviewUrl ? { previewUrl: nextPreviewUrl } : {}),
            ...(nextPreviewUrl ? { previewAddress: nextPreviewUrl } : {}),
            previewLoading: true,
          };
          render();
          return;
        }

        if (action === "forward") {
          if (previewHistory.index >= previewHistory.entries.length - 1) {
            return;
          }

          previewHistory = {
            ...previewHistory,
            index: previewHistory.index + 1,
          };
          const nextPreviewUrl = previewHistory.entries[previewHistory.index];
          uiState = {
            ...uiState,
            ...(nextPreviewUrl ? { previewUrl: nextPreviewUrl } : {}),
            ...(nextPreviewUrl ? { previewAddress: nextPreviewUrl } : {}),
            previewLoading: true,
          };
          render();
          return;
        }

        if (action === "reload") {
          if (!previewFrame) {
            return;
          }

          const currentUrl = previewHistory.entries[previewHistory.index] ?? uiState.previewUrl;
          uiState = {
            ...uiState,
            previewLoading: true,
          };
          previewFrame.src = currentUrl ?? previewFrame.src;
        }
      });
    }

    target.querySelector<HTMLButtonElement>("[data-preview-open]")?.addEventListener("click", () => {
      const url = normalizePreviewUrl(previewUrlInput?.value ?? "");

      if (!url) {
        return;
      }

      window.open(normalizePreviewUrl(url), "_blank", "noopener,noreferrer");
    });

    const form = target.querySelector<HTMLFormElement>('[data-editor-form="interactive-web-editor"]');

    form?.addEventListener("submit", (event) => {
      event.preventDefault();

      const selectedState = createInteractiveWebEditorState(state.webEditor);
      const blockId = selectedState.selectedBlockId ?? selectedState.blocks[0]?.id ?? "workbench";
      const formData = new FormData(form);

      const request: InteractiveWebEditRequest = {
        selection: {
          blockId,
          path: getWebEditorBlockFile(blockId),
        },
        intent: String(formData.get("intent") ?? ""),
        patchStrategy: (String(formData.get("patchStrategy") ?? "refine") as InteractiveWebEditRequest["patchStrategy"]),
        properties: selectedState.properties.map((property) => ({
          ...property,
          value: String(formData.get(`property:${property.key}`) ?? property.value),
        })),
      };

      let nextEditorState = createInteractiveWebEditorState(state.webEditor);

      for (const property of request.properties ?? []) {
        nextEditorState = upsertInteractiveWebEditorProperty(nextEditorState, property);
      }

      const response = createInteractiveWebEditResponse(request, nextEditorState);
      state = {
        ...state,
        webEditor: response.nextState,
      };
      render();
    });

    const composer = target.querySelector<HTMLInputElement>("[data-command-input]");
    composer?.addEventListener("input", () => {
      uiState = {
        ...uiState,
        composerText: composer.value,
      };
    });

    const sendPrompt = () => {
      const text = composer?.value.trim() ?? uiState.composerText.trim();

      if (!text) {
        uiState = {
          ...uiState,
          toast: "Type a request before sending.",
        };
        render();
        return;
      }

      const selectedEditor = createInteractiveWebEditorState(state.webEditor);
      const blockId = selectedEditor.selectedBlockId ?? selectedEditor.blocks[0]?.id ?? "workbench";
      const nextRequest: InteractiveWebEditRequest = {
        selection: {
          blockId,
          path: getWebEditorBlockFile(blockId),
        },
        intent: text,
        patchStrategy: "refine",
        properties: selectedEditor.properties,
      };
      const response = createInteractiveWebEditResponse(nextRequest, selectedEditor);

      state = appendEvent(
        {
          ...state,
          webEditor: response.nextState,
        },
        {
          type: "message.delta",
          messageId: `assistant-ui-${Date.now()}`,
          text: `Queued prompt: ${text}`,
        },
      );
      uiState = {
        ...uiState,
        composerText: "",
        toast: "Prompt routed into the active session.",
      };
      render();
    };

    target.querySelector<HTMLButtonElement>("[data-send-message]")?.addEventListener("click", sendPrompt);
    composer?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        sendPrompt();
      }
    });

    for (const button of Array.from(target.querySelectorAll<HTMLButtonElement>("[data-open-session]"))) {
      button.addEventListener("click", () => {
        const nextId = button.dataset.openSession;

        if (nextId) {
          setSessionHash(nextId);
        }
      });
    }

    target.querySelector<HTMLButtonElement>("[data-go-home]")?.addEventListener("click", () => {
      goHome();
    });

    for (const button of Array.from(target.querySelectorAll<HTMLButtonElement>("[data-open-dialog]"))) {
      button.addEventListener("click", () => {
        const nextDialog = button.dataset.openDialog as DialogKind;
        uiState = {
          ...uiState,
          activeDialog: nextDialog,
        };
        render();
      });
    }

    for (const element of Array.from(target.querySelectorAll<HTMLElement>("[data-close-dialog]"))) {
      element.addEventListener("click", () => {
        uiState = {
          ...uiState,
          activeDialog: undefined,
        };
        render();
      });
    }

    for (const button of Array.from(target.querySelectorAll<HTMLButtonElement>("[data-dialog-copy]"))) {
      button.addEventListener("click", async () => {
        const ok = await copyText(button.dataset.dialogCopy ?? "");
        uiState = {
          ...uiState,
          activeDialog: undefined,
          toast: ok ? "Session link copied." : "Clipboard unavailable in this browser.",
        };
        render();
      });
    }

    target.querySelector<HTMLButtonElement>("[data-confirm-publish]")?.addEventListener("click", () => {
      uiState = {
        ...uiState,
        activeDialog: undefined,
        toast: "Workspace snapshot marked as published.",
      };
      render();
    });

    for (const button of Array.from(target.querySelectorAll<HTMLButtonElement>("[data-apply-replacement]"))) {
      button.addEventListener("click", () => {
        const selectedEditor = createInteractiveWebEditorState(state.webEditor);
        const selectedBlock =
          selectedEditor.blocks.find((block) => block.id === selectedEditor.selectedBlockId) ??
          selectedEditor.blocks[0];

        if (!selectedBlock || !selectedEditor.lastIntent) {
          return;
        }

        const reason =
          target.querySelector<HTMLTextAreaElement>("[data-reject-reason]")?.value.trim() ??
          "Needs broader structural change.";

        state = {
          ...state,
          webEditor: {
            ...selectedEditor,
            suggestedPrompt: createReplacementPrompt(
              selectedEditor.suggestedPrompt ??
                `Replace block ${selectedBlock.id} at ${getWebEditorBlockFile(selectedBlock.id)}.`,
              reason,
            ),
          },
        };
        render();
      });
    }

    for (const button of Array.from(target.querySelectorAll<HTMLButtonElement>("[data-approval-decision]"))) {
      button.addEventListener("click", () => {
        const decision = button.dataset.approvalDecision;
        const pending = state.initialEvents
          .slice()
          .reverse()
          .find((event): event is Extract<AgentEvent, { type: "interaction.required" }> => event.type === "interaction.required");

        if (!decision || !pending || pending.interaction.type !== "confirm") {
          return;
        }

        const reason =
          target.querySelector<HTMLTextAreaElement>("[data-reject-reason]")?.value.trim() ??
          "Replacement requested.";

        state = appendEvent(state, {
          type: "interaction.resolved",
          interactionId: pending.interaction.id,
          status: decision === "approved" ? "approved" : "rejected",
          title: pending.interaction.title,
          summary:
            decision === "approved"
              ? `Approved: ${pending.interaction.summary}`
              : `Rejected: ${pending.interaction.summary}`,
          ...(decision === "rejected" ? { rejectionReason: reason, followUpStrategy: "replace_structure" as const } : {}),
        });

        if (decision === "rejected") {
          const selectedEditor = createInteractiveWebEditorState(state.webEditor);
          state = {
            ...state,
            webEditor: {
              ...selectedEditor,
              suggestedPrompt: createReplacementPrompt(
                selectedEditor.suggestedPrompt ?? "Replace the current patch.",
                reason,
              ),
            },
          };
        }

        uiState = {
          ...uiState,
          toast: decision === "approved" ? "Patch approved." : "Patch rejected and replacement prompt prepared.",
        };
        render();
      });
    }
  };

  render();
}

async function mount(): Promise<void> {
  ensureStyles(document);
  clearEphemeralStyles();
  cleanupLauncherEffects?.();
  cleanupLauncherEffects = undefined;

  const sessionId = getSessionIdFromLocation(window.location);

  if (!sessionId) {
    document.title = "ezuwebs.com | Session Launcher";
    document.body.innerHTML = renderSessionLauncher();
    attachLauncherStyles();
    attachLauncherListeners(document.body);
    return;
  }

  const definition = getDemoSessionDefinition(sessionId);
  document.title = `${definition.projectName} | Session Workspace`;
  ensureWorkspaceUiStyles();
  await mountSessionApp(document.body, sessionId);
}

window.addEventListener("hashchange", () => {
  void mount();
});

void mount();
