import { PausableClock, resolveThreadsRenderMode } from "./threadsAnimation.js";

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

function createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
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

export interface MountThreadsBackgroundOptions {
  onFallback: () => void;
}

/**
 * Mounts the animated "threads" WebGL background inside `target` and
 * returns a cleanup function that cancels the animation frame and releases
 * all GL resources. Falls back to a static gradient (via `onFallback`) when
 * WebGL is unavailable or the shader program fails to build.
 */
export function mountThreadsBackground(
  target: HTMLElement,
  options: MountThreadsBackgroundOptions,
): () => void {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: false,
    desynchronized: true,
    premultipliedAlpha: true,
    powerPreference: "high-performance",
  });

  if (!gl) {
    options.onFallback();
    return () => {};
  }

  canvas.className = "threads-background-canvas";
  target.append(canvas);

  let program: WebGLProgram;
  try {
    program = createProgram(gl);
  } catch (error) {
    console.error(error);
    canvas.remove();
    options.onFallback();
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
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

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

  let redrawAfterResize: (() => void) | undefined;
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
    redrawAfterResize?.();
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

  const handlePointerMove = (event: PointerEvent) => {
    const rect = target.getBoundingClientRect();
    targetMouseX = (event.clientX - rect.left) / rect.width;
    targetMouseY = 1 - (event.clientY - rect.top) / rect.height;
  };

  const handlePointerLeave = () => {
    targetMouseX = 0.5;
    targetMouseY = 0.5;
  };

  const pointerTarget = target.parentElement ?? target;
  pointerTarget.addEventListener("pointermove", handlePointerMove, { passive: true });
  pointerTarget.addEventListener("pointerleave", handlePointerLeave, { passive: true });

  const prefersReducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let isDocumentVisible = !document.hidden;
  const clock = new PausableClock(
    performance.now(),
    isDocumentVisible && !prefersReducedMotionQuery.matches,
  );

  let frameId = 0;

  const currentRenderMode = () =>
    resolveThreadsRenderMode({ webglAvailable: true, prefersReducedMotion: prefersReducedMotionQuery.matches });

  const drawFrame = (nowMs: number) => {
    gl.useProgram(program);
    currentMouseX += 0.1 * (targetMouseX - currentMouseX);
    currentMouseY += 0.1 * (targetMouseY - currentMouseY);
    gl.uniform2f(mouseLocation, currentMouseX, currentMouseY);
    gl.uniform1f(timeLocation, clock.elapsedSeconds(nowMs));
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  redrawAfterResize = () => drawFrame(performance.now());

  const renderFrame = (nowMs: number) => {
    drawFrame(nowMs);
    if (isDocumentVisible && currentRenderMode() === "animated") {
      frameId = requestAnimationFrame(renderFrame);
    }
  };

  drawFrame(performance.now());
  if (isDocumentVisible && currentRenderMode() === "animated") {
    frameId = requestAnimationFrame(renderFrame);
  }

  const handleVisibilityChange = () => {
    isDocumentVisible = !document.hidden;
    if (isDocumentVisible) {
      if (currentRenderMode() === "animated") {
        clock.resume(performance.now());
        frameId = requestAnimationFrame(renderFrame);
      } else {
        drawFrame(performance.now());
      }
    } else {
      clock.pause(performance.now());
      cancelAnimationFrame(frameId);
    }
  };

  const handleReducedMotionChange = () => {
    if (currentRenderMode() === "animated") {
      if (isDocumentVisible) {
        clock.resume(performance.now());
        frameId = requestAnimationFrame(renderFrame);
      }
    } else {
      clock.pause(performance.now());
      cancelAnimationFrame(frameId);
      drawFrame(performance.now());
    }
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  prefersReducedMotionQuery.addEventListener("change", handleReducedMotionChange);

  return () => {
    cancelAnimationFrame(frameId);
    resizeObserver.disconnect();
    window.removeEventListener("resize", resize);
    pointerTarget.removeEventListener("pointermove", handlePointerMove);
    pointerTarget.removeEventListener("pointerleave", handlePointerLeave);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    prefersReducedMotionQuery.removeEventListener("change", handleReducedMotionChange);
    gl.deleteBuffer(geometryBuffer);
    gl.deleteProgram(program);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    canvas.remove();
  };
}
