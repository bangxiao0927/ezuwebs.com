import { type RuntimeAdapter, type RuntimeProcess } from "@ezu/core";
import { type RuntimePort } from "@ezu/protocol";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function createPreviewUrl(html: string): string {
  // This runtime currently executes in the backend process. A blob:nodedata:
  // URL is scoped to that process and cannot be loaded by the browser SPA.
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function renderRuntimePreviewDocument(input: {
  files: Array<{ path: string; content: string }>;
  port: number;
  activePath?: string;
}): string {
  const latestFile =
    input.files.find((file) => file.path === input.activePath) ?? input.files.at(-1);
  const latestContent = latestFile?.content ?? "No file content has been written into the browser container yet.";
  const latestPath = latestFile?.path ?? "No active file";
  const lines = latestContent.length === 0 ? 0 : latestContent.split("\n").length;
  const imports = [...latestContent.matchAll(/^\s*import\s/mg)].length;
  const exports = [...latestContent.matchAll(/^\s*export\s/mg)].length;
  const isHtmlLike =
    /\.html?$/i.test(latestPath) || /^\s*<!doctype html>|^\s*<html[\s>]|^\s*<main[\s>]/i.test(latestContent.trim());
  const previewSource = isHtmlLike
    ? latestContent
    : `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: dark;
        --bg: #06101c;
        --panel: rgba(10, 19, 31, 0.92);
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
      .card {
        padding: 18px;
        border-radius: 20px;
        border: 1px solid var(--line);
        background: var(--panel);
      }
      .eyebrow {
        margin: 0 0 8px;
        color: var(--accent);
        font-size: 12px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      h1, p, pre { margin: 0; }
      p {
        color: var(--muted);
        line-height: 1.6;
      }
      .metrics {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 10px;
      }
      .metric {
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.03);
      }
      .metric strong,
      .metric span {
        display: block;
      }
      .metric strong {
        font-size: 11px;
        color: var(--muted);
        text-transform: uppercase;
      }
      .metric span {
        margin-top: 8px;
      }
      pre {
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
      <section class="card">
        <p class="eyebrow">Browser Runtime</p>
        <h1>${escapeHtml(latestPath)}</h1>
        <p>This file is active in the browser runtime. The preview summarizes structure when the payload is not directly renderable HTML.</p>
      </section>
      <section class="card metrics">
        <article class="metric"><strong>Port</strong><span>${escapeHtml(String(input.port))}</span></article>
        <article class="metric"><strong>Lines</strong><span>${escapeHtml(String(lines))}</span></article>
        <article class="metric"><strong>Imports</strong><span>${escapeHtml(String(imports))}</span></article>
        <article class="metric"><strong>Exports</strong><span>${escapeHtml(String(exports))}</span></article>
      </section>
      <section class="card">
        <p class="eyebrow">Source Sample</p>
        <pre>${escapeHtml(latestContent.split("\n").slice(0, 18).join("\n"))}</pre>
      </section>
    </main>
  </body>
</html>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Browser Runtime Preview</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0c0f14;
        --panel: rgba(19, 23, 30, 0.94);
        --panel-soft: rgba(25, 30, 40, 0.96);
        --ink: #eef2ff;
        --muted: #9aa4b2;
        --line: rgba(255, 255, 255, 0.08);
        --accent: #4f8cff;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: Inter, "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(79, 140, 255, 0.16), transparent 24%),
          linear-gradient(180deg, #0a0d12 0%, var(--bg) 100%);
      }

      main {
        width: min(1120px, calc(100% - 32px));
        margin: 24px auto;
        display: grid;
        gap: 18px;
      }

      section {
        padding: 18px;
        border-radius: 20px;
        border: 1px solid var(--line);
        background: var(--panel);
      }

      h1, h2, h3, p, pre {
        margin: 0;
      }

      .hero {
        display: grid;
        gap: 14px;
      }

      .eyebrow {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: var(--accent);
        font-weight: 700;
      }

      .grid {
        display: grid;
        gap: 18px;
        grid-template-columns: minmax(280px, 0.7fr) minmax(0, 1.3fr);
      }

      .list {
        display: grid;
        gap: 10px;
        padding: 0;
        list-style: none;
      }

      .list li {
        padding: 12px 14px;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: var(--panel-soft);
        color: var(--muted);
      }

      pre {
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        padding: 16px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: #0f1319;
        font-family: ui-monospace, "SFMono-Regular", "Menlo", monospace;
        font-size: 13px;
        line-height: 1.55;
      }

      .viewport {
        display: grid;
        gap: 12px;
      }

      .browser-shell {
        display: grid;
        gap: 12px;
      }

      .browser-bar {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .browser-dots {
        display: flex;
        gap: 8px;
      }

      .browser-dots span {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: #5f6b7b;
      }

      .browser-url {
        flex: 1;
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--panel-soft);
        color: var(--muted);
        font-size: 13px;
      }

      .viewport-frame {
        padding: 18px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: linear-gradient(180deg, #151b24, #10141b);
      }

      .metrics {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 10px;
        margin-top: 14px;
      }

      .metric {
        padding: 14px 16px;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.03);
      }

      .metric strong,
      .metric span {
        display: block;
      }

      .metric strong {
        color: var(--muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .metric span {
        margin-top: 8px;
        word-break: break-word;
      }

      .preview-stage {
        width: 100%;
        min-height: 460px;
        margin-top: 16px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: #ffffff;
      }

      @media (max-width: 720px) {
        .grid {
          grid-template-columns: 1fr;
        }

        .preview-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <p class="eyebrow">Browser Container</p>
        <h1>Live preview on port ${escapeHtml(String(input.port))}</h1>
        <p>This preview is generated inside the in-browser runtime from the virtual file system state.</p>
      </section>
      <div class="grid">
        <section>
          <p class="eyebrow">Files</p>
          <h2>Runtime file system</h2>
          <ul class="list">
            ${
              input.files.length > 0
                ? input.files
                    .map((file) => `<li>${escapeHtml(file.path)}</li>`)
                    .join("")
                : "<li>No files in the runtime yet</li>"
            }
          </ul>
        </section>
        <section class="viewport">
          <div>
            <p class="eyebrow">Surface</p>
            <h2>Rendered payload</h2>
          </div>
          <div class="browser-shell">
            <div class="browser-bar">
              <div class="browser-dots">
                <span></span>
                <span></span>
                <span></span>
              </div>
              <div class="browser-url">browser-runtime://preview:${escapeHtml(String(input.port))}</div>
            </div>
            <div class="viewport-frame">
              <h3>${escapeHtml(latestPath)}</h3>
              <p>${escapeHtml(
                latestFile
                  ? "Latest runtime artifact mirrored into the preview surface."
                  : "Once an action writes or patches a file, its content appears here.",
              )}</p>
              <div class="metrics">
                <article class="metric">
                  <strong>Port</strong>
                  <span>${escapeHtml(String(input.port))}</span>
                </article>
                <article class="metric">
                  <strong>Lines</strong>
                  <span>${escapeHtml(String(lines))}</span>
                </article>
                <article class="metric">
                  <strong>Imports</strong>
                  <span>${escapeHtml(String(imports))}</span>
                </article>
                <article class="metric">
                  <strong>Exports</strong>
                  <span>${escapeHtml(String(exports))}</span>
                </article>
              </div>
              <iframe class="preview-stage" srcdoc="${escapeHtml(previewSource)}" title="Browser runtime preview"></iframe>
            </div>
          </div>
          <pre>${escapeHtml(latestContent)}</pre>
        </section>
      </div>
    </main>
  </body>
</html>`;
}

class BrowserRuntimeProcess implements RuntimeProcess {
  readonly id = crypto.randomUUID();
  private readonly outputListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<(code: number) => void>();
  private closed = false;

  emitOutput(chunk: string): void {
    if (this.closed) {
      return;
    }

    for (const listener of this.outputListeners) {
      listener(chunk);
    }
  }

  emitExit(code: number): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    for (const listener of this.exitListeners) {
      listener(code);
    }
  }

  async kill(): Promise<void> {
    this.emitExit(0);
  }

  onOutput(cb: (chunk: string) => void): void {
    this.outputListeners.add(cb);
  }

  onExit(cb: (code: number) => void): void {
    this.exitListeners.add(cb);
  }
}

export class BrowserRuntimeStub implements RuntimeAdapter {
  private readonly files: Map<string, string>;
  private activePath: string | undefined;
  private readonly fileWatchers = new Set<(event: { path: string; type: string }) => void>();
  private readonly portWatchers = new Set<
    (event: { port: number; url: string; status: "open" | "close" }) => void
  >();
  private readonly openPorts = new Map<number, string>();

  constructor(seedFiles: Array<{ path: string; content: string }> = []) {
    this.files = new Map(seedFiles.map((file) => [file.path, file.content]));
  }

  async readFile(path: string): Promise<string> {
    return this.files.get(path) ?? "";
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    this.activePath = path;
    this.emitFileEvent({ path, type: "write" });
    this.refreshOpenPreviews();
  }

  async patchFile(path: string, patch: string): Promise<void> {
    const current = this.files.get(path) ?? "";
    this.files.set(path, `${current}\n${patch}`.trim());
    this.activePath = path;
    this.emitFileEvent({ path, type: "patch" });
    this.refreshOpenPreviews();
  }

  async listFiles(root: string): Promise<string[]> {
    return [...this.files.keys()].filter((path) => path.startsWith(root)).sort();
  }

  async snapshotFiles(): Promise<Array<{ path: string; content: string }>> {
    return [...this.files.entries()]
      .map(([path, content]) => ({ path, content }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
    this.emitFileEvent({ path, type: "delete" });
    this.refreshOpenPreviews();
  }

  async runCommand(command: string, opts?: { cwd?: string }): Promise<RuntimeProcess> {
    const process = new BrowserRuntimeProcess();

    queueMicrotask(() => {
      process.emitOutput(`$ ${command}\n`);

      if (opts?.cwd) {
        process.emitOutput(`cwd: ${opts.cwd}\n`);
      }

      if (/(dev|serve|preview|start)/i.test(command)) {
        void this.openPreview(4174).then((port) => {
          process.emitOutput(`preview ready: ${port.url}\n`);
          process.emitExit(0);
        });
        return;
      }

      process.emitOutput("command completed inside the browser runtime\n");
      process.emitExit(0);
    });

    return process;
  }

  async openPreview(port = 4174): Promise<RuntimePort> {
    const nextUrl = createPreviewUrl(
      renderRuntimePreviewDocument({
        files: [...this.files.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([path, content]) => ({ path, content })),
        port,
        ...(this.activePath ? { activePath: this.activePath } : {}),
      }),
    );

    this.openPorts.set(port, nextUrl);
    this.emitPortEvent({ port, url: nextUrl, status: "open" });

    return {
      port,
      url: nextUrl,
      status: "open",
    };
  }

  async watchFiles(cb: (event: { path: string; type: string }) => void): Promise<() => void> {
    this.fileWatchers.add(cb);
    return () => {
      this.fileWatchers.delete(cb);
    };
  }

  async watchPorts(
    cb: (event: { port: number; url: string; status: "open" | "close" }) => void,
  ): Promise<() => void> {
    this.portWatchers.add(cb);

    for (const [port, url] of this.openPorts.entries()) {
      cb({ port, url, status: "open" });
    }

    return () => {
      this.portWatchers.delete(cb);
    };
  }

  private emitFileEvent(event: { path: string; type: string }): void {
    for (const listener of this.fileWatchers) {
      listener(event);
    }
  }

  private emitPortEvent(event: { port: number; url: string; status: "open" | "close" }): void {
    for (const listener of this.portWatchers) {
      listener(event);
    }
  }

  private refreshOpenPreviews(): void {
    for (const port of this.openPorts.keys()) {
      void this.openPreview(port);
    }
  }
}

export function createBrowserRuntimeStub(
  seedFiles: Array<{ path: string; content: string }> = [],
): RuntimeAdapter {
  return new BrowserRuntimeStub(seedFiles);
}
