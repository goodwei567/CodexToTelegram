import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { looksLikeInlineMath } from "./latex.js";

const BODY_WIDTH = 900;
const DEVICE_SCALE = 2;
const MAX_CHUNK_HEIGHT = 3_500;
const EDGE_TIMEOUT_MS = 90_000;
const VIRTUAL_TIME_BUDGET_MS = 20_000;
const MEASURE_ATTEMPTS = 3;
const BEACON_GRACE_MS = 2_500;

let cachedEdge: string | null | undefined;

function findEdgeExecutable(): string | null {
  if (cachedEdge !== undefined) return cachedEdge;
  const candidates = [
    process.env.MSEDGE_EXECUTABLE,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter((value): value is string => Boolean(value));
  cachedEdge = candidates.find((candidate) => existsSync(candidate)) ?? null;
  return cachedEdge;
}

function mathjaxBundlePath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, "..", "node_modules", "mathjax-full", "es5", "tex-svg.js");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const inlinePattern =
  /((?<!\\)\$\$[\s\S]+?(?<!\\)\$\$|(?<!\\)\\\[[\s\S]+?\\\]|(?<!\\)\\\([\s\S]+?\\\)|(?<!\\)\$[^$\n]+?(?<!\\)\$|`[^`\n]+`)/g;

function markdownInline(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) =>
      label === url ? label : `${label} (${url})`,
    );
}

function renderInline(text: string): string {
  let out = "";
  let index = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const start = match.index;
    if (start === undefined) continue;
    out += markdownInline(escapeHtml(text.slice(index, start)));
    const token = match[0];
    if (token.startsWith("`")) {
      out += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    } else if (/^\$(?!\$)/.test(token)) {
      // Single-dollar runs only become math when the content actually looks
      // like math; otherwise the dollars are escaped so MathJax leaves
      // prices such as "$5 到 $10" untouched.
      out += looksLikeInlineMath(token.slice(1, -1))
        ? escapeHtml(token)
        : escapeHtml(token).replace(/\$/g, "\\$");
    } else {
      // Math stays verbatim; MathJax renders it in the browser.
      out += escapeHtml(token);
    }
    index = start + token.length;
  }
  out += markdownInline(escapeHtml(text.slice(index)));
  return out;
}

function renderTable(rows: string[][]): string {
  let header: string[] | null = null;
  let body = rows;
  const separator = rows[1];
  if (
    rows.length > 1 &&
    separator &&
    separator.length > 0 &&
    separator.every((cell) => /^:?-{2,}:?$/.test(cell))
  ) {
    header = rows[0] ?? null;
    body = rows.slice(2);
  }
  const head = header
    ? `<thead><tr>${header.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead>`
    : "";
  const rowsHtml = body
    .map((cells) => `<tr>${cells.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<table>${head}<tbody>${rowsHtml}</tbody></table>`;
}

// Converts the assistant's markdown reply into an array of HTML blocks that
// can be measured and paginated independently.
export function markdownToBlocks(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let i = 0;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i]!;

    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++;
      blocks.push(`<pre>${escapeHtml(codeLines.join("\n"))}</pre>`);
      continue;
    }

    if (/^\s*\$\$/.test(line)) {
      const mathLines: string[] = [];
      let first = true;
      while (i < lines.length) {
        const current = lines[i]!;
        mathLines.push(current);
        i++;
        const rest = first ? current.slice(current.indexOf("$$") + 2) : current;
        first = false;
        if (/\$\$\s*$/.test(rest)) break;
      }
      blocks.push(`<div class="disp">${escapeHtml(mathLines.join("\n"))}</div>`);
      continue;
    }

    if (/^\s*\\\[/.test(line)) {
      const mathLines: string[] = [];
      let first = true;
      while (i < lines.length) {
        const current = lines[i]!;
        mathLines.push(current);
        i++;
        const rest = first ? current.slice(current.indexOf("\\[") + 2) : current;
        first = false;
        if (/\\\]\s*$/.test(rest)) break;
      }
      blocks.push(`<div class="disp">${escapeHtml(mathLines.join("\n"))}</div>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = Math.min(heading[1]!.length + 1, 5);
      blocks.push(`<h${level}>${renderInline(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      blocks.push("<hr>");
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(`<blockquote>${renderInline(quote.join("\n"))}</blockquote>`);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph();
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        rows.push(
          lines[i]!
            .trim()
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((cell) => cell.trim()),
        );
        i++;
      }
      blocks.push(renderTable(rows));
      continue;
    }

    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      flushParagraph();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*([-*]|\d+[.)])\s+/, ""));
        i++;
      }
      const inner = items.map((item) => `<li>${renderInline(item)}</li>`).join("");
      blocks.push(ordered ? `<ol>${inner}</ol>` : `<ul>${inner}</ul>`);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      i++;
      continue;
    }

    paragraph.push(line);
    i++;
  }
  flushParagraph();
  return blocks;
}

let pageStyle: string | null = null;

function buildHtml(blocks: string[], reportPort?: number): string {
  const mathjaxUrl = encodeURI(`file:///${mathjaxBundlePath().replace(/\\/g, "/")}`);
  // After MathJax finishes, the page reports its real height through two
  // independent channels: document.title (read from --dump-dom stdout) and a
  // tiny local HTTP beacon. The beacon keeps rendering working even in launch
  // contexts where the browser's stdout is silently swallowed.
  const beaconScript = reportPort
    ? `
        try { new Image().src = 'http://127.0.0.1:${reportPort}/h?h=' + h + '&r=' + Math.random(); } catch (e) {}
        try { fetch('http://127.0.0.1:${reportPort}/h?h=' + h, { mode: 'no-cors' }).catch(function () {}); } catch (e) {}`
    : "";
  pageStyle ??= `
  body { margin: 0; width: ${BODY_WIDTH}px; background: #ffffff; color: #1f2328;
    font-family: "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif;
    font-size: 15px; line-height: 1.7; -webkit-font-smoothing: antialiased; }
  #content { padding: 26px 30px; }
  p { margin: 8px 0; }
  h1 { font-size: 21px; margin: 10px 0 8px; }
  h2 { font-size: 19px; margin: 12px 0 8px; }
  h3 { font-size: 17px; margin: 12px 0 7px; }
  h4, h5 { font-size: 15.5px; margin: 10px 0 6px; }
  .disp { text-align: center; margin: 14px 0; }
  mjx-container { max-width: 100%; }
  pre { background: #f6f8fa; border-radius: 8px; padding: 12px 14px;
    font-family: Consolas, "Courier New", monospace; font-size: 13px; line-height: 1.55;
    white-space: pre-wrap; word-break: break-word; }
  code { background: #f0f2f4; border-radius: 4px; padding: 1px 5px;
    font-family: Consolas, "Courier New", monospace; font-size: 13px; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #d0d7de; margin: 10px 0; padding: 2px 14px; color: #57606a; }
  ul, ol { margin: 8px 0; padding-left: 26px; }
  li { margin: 3px 0; }
  table { border-collapse: collapse; margin: 12px 0; }
  th, td { border: 1px solid #d0d7de; padding: 5px 10px; font-size: 14px; }
  th { background: #f6f8fa; }
  hr { border: none; border-top: 1px solid #d8dee4; margin: 16px 0; }`;
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>${pageStyle}</style>
<script>
window.MathJax = {
  tex: {
    inlineMath: [['$', '$'], ['\\\\(', '\\\\)']],
    displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']]
  },
  svg: { fontCache: 'local' },
  options: { enableMenu: false },
  startup: {
    pageReady() {
      return MathJax.startup.defaultPageReady().then(() => {
        var h = Math.ceil(document.body.offsetHeight);
        document.title = 'M=' + h;${beaconScript}
      });
    }
  }
};
</script>
<script src="${mathjaxUrl}"></script>
</head><body><div id="content">${blocks.join("\n")}</div></body></html>`;
}

interface EdgeRunResult {
  stdout: string;
  stderr: string;
}

function baseEdgeArgs(profileDir: string): string[] {
  return [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    // The page is fully self-contained (file:// + inlined assets); keep
    // the browser away from proxy/network work that can stall rendering.
    "--no-proxy-server",
    "--disable-background-networking",
    "--disable-component-update",
    // Record why a launch misbehaves (e.g. a silent profile hand-off) on
    // stderr; it only surfaces in the diagnostics log on failure.
    "--enable-logging=stderr",
    `--user-data-dir=${profileDir}`,
    `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
  ];
}

function runEdge(edge: string, profileDir: string, args: string[]): Promise<EdgeRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      edge,
      [...baseEdgeArgs(profileDir), ...args],
      { encoding: "utf8", timeout: EDGE_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String((error as Error).message).split("\n")[0]!;
          const stderrHead = stderr.replace(/\s+/g, " ").trim().slice(0, 300);
          reject(new Error(stderrHead ? `${detail} [stderr: ${stderrHead}]` : detail));
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BeaconState {
  height: number;
}

// A one-shot local HTTP server the rendered page reports its height to.
function startBeaconServer(state: BeaconState): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const height = Number(url.searchParams.get("h"));
        if (url.pathname === "/h" && Number.isFinite(height) && height > 0) {
          state.height = Math.ceil(height);
        }
      } catch {
        // Ignore malformed reports.
      }
      response.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      response.end();
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve({ server, port: address.port });
      } else {
        reject(new Error("Could not start the render report server."));
      }
    });
  });
}

// All attempts load the same page file, so a late beacon from an earlier
// attempt is still a valid height for this measurement.
async function waitForBeacon(state: BeaconState, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (state.height <= 0 && Date.now() < deadline) {
    await sleep(100);
  }
  return state.height;
}

// Runs Edge through cmd.exe with stdout/stderr redirected to files, bypassing
// the child-process pipe entirely for launch contexts that swallow it.
async function runEdgeToFile(
  edge: string,
  profileDir: string,
  workDir: string,
  args: string[],
  tag: string,
): Promise<{ dump: string; stderr: string; note: string }> {
  const batPath = path.join(workDir, `measure-${process.pid}-${tag}.cmd`);
  const outPath = path.join(workDir, `dump-${process.pid}-${tag}.txt`);
  const errPath = path.join(workDir, `err-${process.pid}-${tag}.txt`);
  const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;
  const commandLine = [
    quote(edge),
    ...[...baseEdgeArgs(profileDir), ...args].map(quote),
    `1>${quote(outPath)}`,
    `2>${quote(errPath)}`,
  ].join(" ");
  let note = "redirect";
  try {
    await writeFile(batPath, `@echo off\r\n${commandLine}\r\n`, "utf8");
    await new Promise<void>((resolve, reject) => {
      execFile(
        "cmd.exe",
        ["/d", "/s", "/c", batPath],
        { encoding: "utf8", timeout: EDGE_TIMEOUT_MS + 10_000, windowsHide: true },
        (error) => {
          const execError = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
          const code = execError ? (execError.code ?? "failed") : 0;
          note = `redirect exit=${String(code)}`;
          if (execError?.killed) reject(error);
          else resolve();
        },
      );
    });
  } finally {
    await rm(batPath, { force: true }).catch(() => undefined);
  }
  const dump = await readFile(outPath, "utf8").catch(() => "");
  const stderr = await readFile(errPath, "utf8").catch(() => "");
  await rm(outPath, { force: true }).catch(() => undefined);
  await rm(errPath, { force: true }).catch(() => undefined);
  return { dump, stderr, note };
}

function isProcessElevated(): boolean {
  try {
    execFileSync("fltmc", [], { windowsHide: true, stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// Kills Edge processes still holding our render profile (a browser process can
// survive its killed launcher). Only command lines mentioning the render
// profile path are targeted, so the user's own browser is never touched.
async function killProfileEdgeProcesses(profileDir: string): Promise<number> {
  const pattern = profileDir.replace(/'/g, "''");
  const script = [
    `$targets = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -like '*${pattern}*' }`,
    `$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    `($targets | Measure-Object).Count`,
  ].join("; ");
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", timeout: 20_000, windowsHide: true },
      (_error, stdout) => {
        const count = Number(String(stdout).trim());
        resolve(Number.isFinite(count) ? count : 0);
      },
    );
  });
}

async function writeRenderDiagnostics(
  workDir: string,
  edge: string,
  attemptLog: string[],
  lastDetail: string,
): Promise<string> {
  const logPath = path.join(workDir, "last-render-error.log");
  const lines = [
    `time: ${new Date().toISOString()}`,
    `edge: ${edge}`,
    `bridge elevated: ${isProcessElevated()}`,
    `cwd: ${process.cwd()}`,
    `proxy env: HTTP_PROXY=${process.env.HTTP_PROXY ? "set" : "unset"}, HTTPS_PROXY=${process.env.HTTPS_PROXY ? "set" : "unset"}`,
    `lastDetail: ${lastDetail}`,
    "attempts:",
    ...attemptLog.map((entry) => `  ${entry}`),
  ];
  await writeFile(logPath, `${lines.join("\n")}\n`, "utf8").catch(() => undefined);
  return logPath;
}

let renderChain: Promise<unknown> = Promise.resolve();
let htmlCounter = 0;

function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
  const run = renderChain.then(task, task);
  renderChain = run.catch(() => undefined);
  return run;
}

async function writePage(workDir: string, blocks: string[], reportPort?: number): Promise<string> {
  const htmlPath = path.join(workDir, `page-${process.pid}-${htmlCounter++}.html`);
  await writeFile(htmlPath, buildHtml(blocks, reportPort), "utf8");
  return htmlPath;
}

async function measureBlocks(
  edge: string,
  profileDir: string,
  workDir: string,
  blocks: string[],
): Promise<{ htmlPath: string; height: number; profileDir: string }> {
  const beaconState: BeaconState = { height: 0 };
  const { server, port } = await startBeaconServer(beaconState);
  try {
    const htmlPath = await writePage(workDir, blocks, port);
    const url = encodeURI(`file:///${htmlPath.replace(/\\/g, "/")}`);
    // Attempts 1-2 use the warm shared profile over the normal pipe; attempt 3
    // switches to a throwaway profile *and* a cmd-level file redirect, which
    // covers a shared profile held by another Edge instance and launch
    // contexts that swallow the browser's stdout. Every attempt also listens
    // for the page's HTTP height beacon.
    const profiles = [profileDir, profileDir, `${profileDir}-tmp-${Date.now()}`];
    const attemptLog: string[] = [];
    const domArgs = ["--window-size=1000,800", "--dump-dom", url];
    let lastDom = "";
    let lastDetail = "";
    for (let attempt = 0; attempt < MEASURE_ATTEMPTS; attempt++) {
      const attemptProfile = profiles[Math.min(attempt, profiles.length - 1)]!;
      beaconState.height = 0;
      const useRedirect = attempt === MEASURE_ATTEMPTS - 1;
      let dom = "";
      let stderr = "";
      let channel = "pipe";
      try {
        if (useRedirect) {
          const result = await runEdgeToFile(
            edge,
            attemptProfile,
            workDir,
            domArgs,
            `${Date.now()}-${attempt}`,
          );
          dom = result.dump;
          stderr = result.stderr;
          channel = result.note;
        } else {
          const result = await runEdge(edge, attemptProfile, domArgs);
          dom = result.stdout;
          stderr = result.stderr;
        }
        // Test hook: simulate a launch context that swallows stdout so the
        // HTTP beacon path can be verified end to end.
        if (process.env.RENDER_IGNORE_STDOUT === "1") dom = "";
      } catch (error) {
        // Another Edge instance may hold the profile; retry (including with a
        // throwaway profile below) instead of giving up.
        lastDetail = error instanceof Error ? error.message.split("\n")[0]! : String(error);
        attemptLog.push(`attempt ${attempt + 1} (${channel}): ${lastDetail}`);
        await sleep(1_500);
        continue;
      }
      lastDom = dom;
      const height = Number(/<title>M=(\d+)<\/title>/.exec(dom)?.[1]);
      if (Number.isFinite(height) && height > 0) {
        return { htmlPath, height, profileDir: attemptProfile };
      }
      const beaconHeight = await waitForBeacon(beaconState, BEACON_GRACE_MS);
      if (beaconHeight > 0) {
        attemptLog.push(`attempt ${attempt + 1} (${channel}): measured via beacon, h=${beaconHeight}`);
        return { htmlPath, height: beaconHeight, profileDir: attemptProfile };
      }
      const stderrHead = stderr.replace(/\s+/g, " ").trim().slice(0, 240);
      lastDetail = `${channel} dump ${dom.length} bytes`;
      attemptLog.push(
        `attempt ${attempt + 1} (${channel}): dump=${dom.length}B, beacon=none${stderrHead ? `, stderr="${stderrHead}"` : ""}`,
      );
      // A cold browser start can miss the measurement under load; give it a
      // moment and try again before giving up on rendering.
      await sleep(1_500);
    }
    // Last resort: a zombie Edge holding the profile can make every launch
    // hand off soundlessly; sweep ours and retry once.
    const killed = await killProfileEdgeProcesses(profileDir);
    if (killed > 0) {
      attemptLog.push(`swept ${killed} stale Edge process(es) holding the profile`);
      await sleep(800);
      beaconState.height = 0;
      try {
        const result = await runEdge(edge, profileDir, domArgs);
        const height = Number(/<title>M=(\d+)<\/title>/.exec(result.stdout)?.[1]);
        if (Number.isFinite(height) && height > 0) {
          return { htmlPath, height, profileDir };
        }
        const beaconHeight = await waitForBeacon(beaconState, BEACON_GRACE_MS);
        if (beaconHeight > 0) {
          return { htmlPath, height: beaconHeight, profileDir };
        }
        lastDetail = `retry dump ${result.stdout.length} bytes`;
        attemptLog.push(`retry after sweep: dump=${result.stdout.length}B, beacon=none`);
      } catch (error) {
        lastDetail = error instanceof Error ? error.message.split("\n")[0]! : String(error);
        attemptLog.push(`retry after sweep: ${lastDetail}`);
      }
    }
    const snippet = lastDom.replace(/\s+/g, " ").slice(0, 200);
    if (snippet) attemptLog.push(`last dump head: ${snippet}`);
    const logPath = await writeRenderDiagnostics(workDir, edge, attemptLog, lastDetail);
    throw new Error(
      `Could not measure the rendered reply height (${lastDetail || "no attempts"}; details: ${logPath}).`,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function screenshotBlocks(
  edge: string,
  profileDir: string,
  workDir: string,
  htmlPath: string,
  height: number,
): Promise<Buffer> {
  const pngPath = path.join(workDir, `shot-${process.pid}-${htmlCounter++}.png`);
  const url = encodeURI(`file:///${htmlPath.replace(/\\/g, "/")}`);
  const shotArgs = [
    `--force-device-scale-factor=${DEVICE_SCALE}`,
    `--window-size=${BODY_WIDTH},${Math.ceil(height) + 2}`,
    `--screenshot=${pngPath}`,
    url,
  ];
  // Same escalation as measuring: warm profile twice, throwaway profile last.
  const profiles = [profileDir, profileDir, `${profileDir}-tmp-${Date.now()}`];
  let lastDetail = "";
  for (let attempt = 0; attempt < profiles.length; attempt++) {
    try {
      const result = await runEdge(edge, profiles[attempt]!, shotArgs);
      const png = await readFile(pngPath);
      if (png.length >= 2_000) {
        await rm(pngPath, { force: true });
        return png;
      }
      const stderrHead = result.stderr.replace(/\s+/g, " ").trim().slice(0, 200);
      lastDetail = `screenshot ${png.length} bytes${stderrHead ? `, stderr="${stderrHead}"` : ""}`;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message.split("\n")[0]! : String(error);
    }
    await sleep(1_000);
  }
  await rm(pngPath, { force: true });
  throw new Error(`Edge did not produce a reply image (${lastDetail || "no attempts"}).`);
}

function splitTallBlock(block: string): string[] | null {
  const match = block.match(/^<pre>([\s\S]*)<\/pre>$/);
  if (!match) return null;
  const codeLines = match[1]!.split("\n");
  if (codeLines.length < 4) return null;
  const mid = Math.ceil(codeLines.length / 2);
  return [
    `<pre>${codeLines.slice(0, mid).join("\n")}</pre>`,
    `<pre>${codeLines.slice(mid).join("\n")}</pre>`,
  ];
}

async function renderChunks(
  edge: string,
  profileDir: string,
  workDir: string,
  blocks: string[],
  images: Buffer[],
): Promise<void> {
  if (blocks.length === 0) return;
  const { htmlPath, height, profileDir: measuredWith } = await measureBlocks(
    edge,
    profileDir,
    workDir,
    blocks,
  );
  if (height > MAX_CHUNK_HEIGHT) {
    if (blocks.length > 1) {
      const mid = Math.ceil(blocks.length / 2);
      await rm(htmlPath, { force: true });
      await renderChunks(edge, profileDir, workDir, blocks.slice(0, mid), images);
      await renderChunks(edge, profileDir, workDir, blocks.slice(mid), images);
      return;
    }
    const split = splitTallBlock(blocks[0]!);
    if (split) {
      await rm(htmlPath, { force: true });
      await renderChunks(edge, profileDir, workDir, split, images);
      return;
    }
  }
  try {
    images.push(await screenshotBlocks(edge, measuredWith, workDir, htmlPath, height));
  } finally {
    await rm(htmlPath, { force: true });
  }
}

async function removeThrowawayProfiles(workDir: string): Promise<void> {
  try {
    const entries = await readdir(workDir);
    for (const entry of entries) {
      if (!entry.includes("edge-profile-tmp-") && !/^(dump|err|measure)-/.test(entry)) continue;
      await rm(path.join(workDir, entry), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  } catch {
    // Cleanup is best effort.
  }
}

// Renders a full reply (markdown + LaTeX) into one or more page images.
export async function renderReplyImages(text: string, runtimeDir: string): Promise<Buffer[]> {
  const edge = findEdgeExecutable();
  if (!edge) {
    throw new Error("Microsoft Edge was not found; cannot render reply images.");
  }
  const blocks = markdownToBlocks(text);
  if (blocks.length === 0) throw new Error("Nothing to render.");
  const workDir = path.join(runtimeDir, "render");
  const profileDir = path.join(workDir, "edge-profile");
  await mkdir(profileDir, { recursive: true });
  return enqueueRender(async () => {
    const images: Buffer[] = [];
    try {
      await renderChunks(edge, profileDir, workDir, blocks, images);
      if (images.length === 0) throw new Error("The rendering run produced no images.");
      return images;
    } finally {
      await removeThrowawayProfiles(workDir);
    }
  });
}
