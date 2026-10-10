#!/usr/bin/env node
/**
 * Layout verification for the plugin's tab UI.
 *
 * jsdom does no layout, so `npm test` cannot catch a misalignment — and the one
 * real layout bug this plugin shipped (numeric table headers silently losing
 * `text-align: right` to a higher-specificity rule) was invisible to every test
 * we had. This script renders the compiled panel in real Chrome and measures it.
 *
 * What it does:
 *   1. mounts the built `dist/index.js` against a synthetic transcript
 *   2. writes `artifacts/layout-preview.html` (self-contained, openable)
 *   3. launches headless Chrome and, over the DevTools Protocol, reads each
 *      table cell's `getBoundingClientRect()` and computed `text-align`
 *   4. fails when a numeric column's header disagrees with its value cells
 *
 * Usage:
 *   node scripts/verify-layout.mjs                 # measure and report
 *   node scripts/verify-layout.mjs --screenshot    # also write a PNG
 *   node scripts/verify-layout.mjs --keep          # leave Chrome running
 *
 * Requires Chrome or Edge on the machine. Not part of `npm test`.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const PANEL_WIDTH = 880;
const DEBUG_PORT = 9411;

const args = new Set(process.argv.slice(2));
const WANT_SCREENSHOT = args.has('--screenshot');
const KEEP_CHROME = args.has('--keep');

/* ── fixture ─────────────────────────────────────────────────────────────── */

const SESSION_ID = 'layout-check';
const PROJECT_PATH = 'D:/layout-check';
const BASE = Date.parse('2026-10-09T09:00:00Z');

function assistant({ input, cacheRead, cacheCreation, output, at, model = 'claude-opus-5-5' }) {
  return {
    type: 'assistant',
    uuid: `u-${at}`,
    timestamp: new Date(BASE + at * 1000).toISOString(),
    sessionId: SESSION_ID,
    requestId: `req-${at}`,
    version: '1.0.24',
    message: {
      id: `msg-${at}`,
      model,
      role: 'assistant',
      content: [{ type: 'text', text: 'x' }],
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
      },
    },
  };
}

/**
 * Deliberately includes one cache break, one second model, and a `cost-state`
 * checkpoint, so every table and every card in the panel actually renders —
 * a preview that skips a section cannot verify it.
 */
function buildLines() {
  return [
    assistant({ input: 5000, cacheRead: 0, cacheCreation: 40000, output: 300, at: 0 }),
    assistant({ input: 1000, cacheRead: 40000, cacheCreation: 20000, output: 300, at: 60 }),
    assistant({ input: 900, cacheRead: 60000, cacheCreation: 10000, output: 300, at: 300 }),
    assistant({ input: 847, cacheRead: 68920, cacheCreation: 9015, output: 263, at: 3600 }),
    // Break: cacheRead collapses from 68,920 to 3,000 with a wall-clock gap that
    // exceeds the 5-minute TTL.
    assistant({ input: 20000, cacheRead: 3000, cacheCreation: 12000, output: 200, at: 3660 }),
    assistant({ input: 120, cacheRead: 21000, cacheCreation: 11000, output: 210, at: 3720, model: 'claude-haiku-4-5' }),
    {
      type: 'cost-state',
      sessionId: SESSION_ID,
      timestamp: new Date(BASE + 3800 * 1000).toISOString(),
      totalCostUSD: 0.4831,
      totalAPIDuration: 42000,
      totalAPIDurationWithoutRetries: 41000,
      totalToolDuration: 3000,
      totalDuration: 3800000,
      startTime: BASE,
      hasUnknownModelCost: false,
      modelUsage: {
        'claude-opus-5-5': {
          inputTokens: 7710,
          outputTokens: 1120,
          cacheReadInputTokens: 172920,
          cacheCreationInputTokens: 91015,
          webSearchRequests: 0,
          costUSD: 0.47,
        },
        'claude-haiku-4-5': {
          inputTokens: 120,
          outputTokens: 210,
          cacheReadInputTokens: 21000,
          cacheCreationInputTokens: 11000,
          webSearchRequests: 0,
          costUSD: 0.0131,
        },
      },
    },
  ];
}

/* ── render ──────────────────────────────────────────────────────────────── */

async function renderPreview() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'cache-hit-layout-'));
  const dir = path.join(home, '.claude', 'projects', PROJECT_PATH.replace(/[^a-zA-Z0-9-]/g, '-'));
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${SESSION_ID}.jsonl`);
  await fsp.writeFile(file, `${buildLines().map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');

  const { summarizeSessionFile } = await import(pathToFileURL(path.join(ROOT, 'dist', 'analyze', 'summarize.js')).href);
  const summary = await summarizeSessionFile({ file, sessionId: SESSION_ID, projectPath: PROJECT_PATH, force: true });

  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;

  try {
    const mod = await import(pathToFileURL(path.join(ROOT, 'dist', 'index.js')).href);
    const context = { theme: 'light', project: { name: 'layout-check', path: PROJECT_PATH }, session: { id: 'app', title: 'layout-check' } };
    const api = {
      get context() {
        return context;
      },
      onContextChange() {
        return () => {};
      },
      async rpc(_method, route) {
        if (/^health/.test(route)) {
          return {
            ok: true, plugin: 'cache-hit', node: process.version, pid: 1, home,
            claudeProjectsDirectory: path.join(home, '.claude', 'projects'),
            claudeProjectsExists: true, projectDirectories: 1, cacheEntries: 1, startedAt: Date.now(),
          };
        }
        if (/^sessions/.test(route)) return { projectPath: PROJECT_PATH, projectDirectory: dir, sessions: [], warnings: [] };
        if (/^session/.test(route)) return summary;
        if (/^overview/.test(route)) {
          return {
            scope: 'project', projectPath: PROJECT_PATH, projectsScanned: 1, sessions: 1, skippedSessions: 0,
            totals: summary.totals, models: summary.models, days: [], breaks: [], topBreakSessions: [], warnings: [],
          };
        }
        throw new Error(`unexpected route ${route}`);
      },
    };

    const host = dom.window.document.createElement('div');
    host.style.width = `${PANEL_WIDTH}px`;
    dom.window.document.body.appendChild(host);
    await mod.mount(host, api);
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    const style = dom.window.document.getElementById('cache-hit-styles')?.textContent ?? '';
    await fsp.mkdir(ARTIFACTS, { recursive: true });
    const previewPath = path.join(ARTIFACTS, 'layout-preview.html');
    await fsp.writeFile(
      previewPath,
      `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:24px;background:#fff}
${style}
</style></head><body>${host.outerHTML}</body></html>`,
      'utf8',
    );
    return { previewPath, summary };
  } finally {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    dom.window.close();
  }
}

/* ── chrome ──────────────────────────────────────────────────────────────── */

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

const MEASURE_EXPR = `JSON.stringify([...document.querySelectorAll('.ch-table')].map((t) => {
  const head = t.querySelector('thead tr');
  const body = t.querySelector('tbody tr');
  const h = head ? head.children : [];
  const b = body ? body.children : [];
  const cells = [];
  for (let i = 0; i < Math.max(h.length, b.length); i++) {
    cells.push({
      head: h[i] ? h[i].textContent.trim() : null,
      thAlign: h[i] ? getComputedStyle(h[i]).textAlign : null,
      tdAlign: b[i] ? getComputedStyle(b[i]).textAlign : null,
      thR: h[i] ? +h[i].getBoundingClientRect().right.toFixed(1) : null,
      tdR: b[i] ? +b[i].getBoundingClientRect().right.toFixed(1) : null,
      tdNumeric: b[i] ? b[i].classList.contains('ch-num') : false,
    });
  }
  const section = t.closest('.ch-section');
  return { title: section ? section.querySelector('.ch-section-head span')?.textContent?.trim() ?? '?' : '?', cells };
}))`;

async function inspect(chrome, url, wantScreenshot) {
  // Profile lives outside the repo and is unique per run: a reused profile makes
  // a concurrent Chrome fail with EBUSY on its first_party_sets.db.
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'cache-hit-chrome-'));
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      `--window-size=${PANEL_WIDTH + 40},4000`,
      url,
    ],
    { stdio: 'ignore' },
  );

  let targets = null;
  for (let i = 0; i < 60 && !targets; i += 1) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!targets) throw new Error('could not reach Chrome over the DevTools Protocol');

  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('Chrome exposed no page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('DevTools WebSocket failed'));
  });

  let nextId = 0;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const onMessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        ws.removeEventListener('message', onMessage);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      };
      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const result = await call('Runtime.evaluate', { expression: MEASURE_EXPR, returnByValue: true });
  const tables = JSON.parse(result.result.value);

  // Captured from the SAME instance: a second Chrome would contend for the
  // profile and the screenshot would silently race the first one's shutdown.
  let screenshot = null;
  if (wantScreenshot) {
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    screenshot = Buffer.from(shot.data, 'base64');
  }

  ws.close();
  return { child, profile, tables, screenshot };
}

/* ── main ────────────────────────────────────────────────────────────────── */

const { previewPath, summary } = await renderPreview();
const url = pathToFileURL(previewPath).href;
console.log(`preview : ${path.relative(ROOT, previewPath)}`);
console.log(`fixture : ${summary.totals.turns} turns, prompt ${summary.totals.promptTokens}, ` +
  `${summary.breaks.length} break(s), rate ${summary.outputTokensPerSecond?.toFixed(1)} tok/s (${summary.rateBasis})`);

const chrome = findChrome();
if (!chrome) {
  console.log('\nNo Chrome/Edge found — wrote the preview only. Set CHROME_PATH to measure.');
  process.exit(0);
}

const { child, profile, tables, screenshot } = await inspect(chrome, url, WANT_SCREENSHOT);
console.log(`browser : ${chrome}\n`);

let failures = 0;
for (const table of tables) {
  console.log(`── ${table.title} ──`);
  for (const cell of table.cells) {
    // A numeric value cell must have a header that resolves to the same side,
    // or the column renders visibly shifted — the exact bug this guards.
    const mismatch = cell.tdNumeric && cell.thAlign !== cell.tdAlign;
    if (mismatch) failures += 1;
    console.log(
      `   ${String(cell.head).padEnd(12)} th=${String(cell.thAlign).padEnd(6)} td=${String(cell.tdAlign).padEnd(6)}` +
        ` thR=${String(cell.thR).padStart(7)} tdR=${String(cell.tdR).padStart(7)}${mismatch ? '   <-- MISALIGNED' : ''}`,
    );
  }
  console.log();
}

if (screenshot) {
  const shot = path.join(ARTIFACTS, 'layout-preview.png');
  await fsp.writeFile(shot, screenshot);
  console.log(`screenshot: ${path.relative(ROOT, shot)}\n`);
}

if (!KEEP_CHROME) child.kill();
await new Promise((resolve) => setTimeout(resolve, 500));
await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});

console.log(failures === 0 ? 'layout: OK — every numeric column agrees with its header' : `layout: ${failures} misaligned column(s)`);
process.exit(failures === 0 ? 0 : 1);
