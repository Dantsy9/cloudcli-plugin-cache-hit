/**
 * End-to-end check of the real plugin server process.
 *
 * Verifies the parts the in-process tests cannot: the readiness protocol the
 * CloudCLI host depends on, the RPC routes, HTTP error shapes, and graceful
 * SIGTERM shutdown.
 *
 * stdout is redirected to a FILE rather than a pipe on purpose: puppeteering a
 * child through a named pipe is blocked in some sandboxed environments, and a
 * file also mirrors what the host does (it reads the child's stdout line by
 * line looking for the ready signal).
 *
 * Run: npm run test:e2e   (after npm run build)
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');

const PROJECT_PATH = 'D:\\e2e\\demo';
const SESSION_ID = 'e2e-session';
const BASE_MS = Date.parse('2026-04-01T08:00:00.000Z');

function assistant(input, cacheRead, cacheCreation, output, offsetSeconds, model = 'claude-sonnet-4-5') {
  return {
    type: 'assistant',
    uuid: `u-${offsetSeconds}`,
    timestamp: new Date(BASE_MS + offsetSeconds * 1000).toISOString(),
    sessionId: SESSION_ID,
    requestId: `req-${offsetSeconds}`,
    version: '1.0.24',
    message: {
      id: `msg-${offsetSeconds}`,
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

function encodeProjectPath(projectPath) {
  return projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
}

async function makeFixtureHome() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'cache-hit-e2e-'));
  const directory = path.join(home, '.claude', 'projects', encodeProjectPath(PROJECT_PATH));
  await fsp.mkdir(directory, { recursive: true });

  // Cold start, a healthy hit, then a break big enough to clear the 2000-token floor.
  const lines = [
    assistant(5000, 0, 20000, 100, 0),
    assistant(200, 24000, 800, 150, 30),
    assistant(20000, 3000, 12000, 200, 90),
  ];
  await fsp.writeFile(
    path.join(directory, `${SESSION_ID}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    'utf8',
  );
  return home;
}

async function waitForPort(logFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let text = '';
    try {
      text = await fsp.readFile(logFile, 'utf8');
    } catch {
      // not created yet
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.ready === true && typeof parsed.port === 'number') return parsed;
      } catch {
        // partial line, keep polling
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not report ready within ${timeoutMs}ms`);
}

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok   - ${name}`))
    .catch((error) => {
      failures += 1;
      console.log(`FAIL - ${name}\n       ${error.message}`);
    });
}

async function main() {
  const home = await makeFixtureHome();
  const logFile = path.join(home, 'server-stdout.log');
  const logHandle = await fsp.open(logFile, 'w');

  // stdio[1] is a file descriptor, not a pipe — deliberately.
  const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'dist', 'server.js')], {
    cwd: PLUGIN_ROOT,
    env: { PATH: process.env.PATH, HOME: home, NODE_ENV: 'production', PLUGIN_NAME: 'cache-hit' },
    stdio: ['ignore', logHandle.fd, 'inherit'],
  });
  await logHandle.close();

  let ready;
  try {
    ready = await waitForPort(logFile, 10_000);
  } catch (error) {
    console.log(`FAIL - readiness protocol\n       ${error.message}`);
    console.log(await fsp.readFile(logFile, 'utf8').catch(() => '(no output)'));
    child.kill();
    process.exit(1);
  }
  console.log(`ok   - readiness protocol ({"ready":true,"port":${ready.port}})`);

  const base = `http://127.0.0.1:${ready.port}`;
  const get = async (route) => {
    const response = await fetch(`${base}${route}`);
    const body = await response.json();
    return { status: response.status, body };
  };

  await check('GET /health reports the resolved home and project directory', async () => {
    const { status, body } = await get('/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.plugin, 'cache-hit');
    assert.equal(body.home, home, 'HOME must be the only state the server reads');
    assert.equal(body.projectDirectories, 1);
    assert.equal(body.claudeProjectsExists, true);
    assert.match(body.claudeProjectsDirectory, /\.claude[\\/]projects$/);
  });

  await check('GET /sessions lists the transcript with its active flag', async () => {
    const { status, body } = await get(`/sessions?projectPath=${encodeURIComponent(PROJECT_PATH)}`);
    assert.equal(status, 200);
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].sessionId, SESSION_ID);
    assert.equal(body.sessions[0].active, true);
    assert.ok(body.sessions[0].size > 0);
  });

  await check('GET /session returns the full analysis', async () => {
    const { status, body } = await get(`/session?projectPath=${encodeURIComponent(PROJECT_PATH)}`);
    assert.equal(status, 200);
    assert.equal(body.sessionId, SESSION_ID);
    assert.equal(body.totals.turns, 3);
    assert.equal(body.totals.input, 25200);
    assert.equal(body.totals.cacheRead, 27000);
    assert.equal(body.totals.cacheCreation, 32800);
    assert.equal(body.totals.promptTokens, 85000);
    assert.ok(Math.abs(body.totals.hitRate - 27000 / 85000) < 1e-12);
    assert.equal(body.breaks.length, 1);
    assert.equal(body.breaks[0].cause, 'prefix_changed');
    assert.equal(body.breaks[0].lostCachedTokens, 21000);
    assert.ok(body.totals.cost.actualUSD > 0);
    assert.equal(typeof body.transcript.file, 'string');
  });

  await check('GET /session accepts an explicit sessionId', async () => {
    const { status, body } = await get(
      `/session?projectPath=${encodeURIComponent(PROJECT_PATH)}&sessionId=${SESSION_ID}`,
    );
    assert.equal(status, 200);
    assert.equal(body.sessionId, SESSION_ID);
  });

  await check('GET /session falls back to the newest transcript and says so', async () => {
    const { body } = await get(
      `/session?projectPath=${encodeURIComponent(PROJECT_PATH)}&sessionId=does-not-exist`,
    );
    assert.equal(body.sessionId, SESSION_ID);
    assert.ok(body.warnings[0].includes('回退'), 'the fallback must be disclosed, not silent');
  });

  await check('GET /overview aggregates the project', async () => {
    const { status, body } = await get(`/overview?projectPath=${encodeURIComponent(PROJECT_PATH)}`);
    assert.equal(status, 200);
    assert.equal(body.scope, 'project');
    assert.equal(body.sessions, 1);
    assert.equal(body.totals.turns, 3);
    assert.equal(body.days.length, 1);
    assert.equal(body.days[0].sessions, 1);
    assert.equal(body.breaks.length, 1);
    assert.equal(body.topBreakSessions.length, 1);
    assert.equal(body.topBreakSessions[0].lostCachedTokens, 21000);
  });

  await check('GET /overview?all=1 scans every project directory', async () => {
    const { status, body } = await get('/overview?all=1');
    assert.equal(status, 200);
    assert.equal(body.scope, 'all');
    assert.equal(body.projectsScanned, 1);
    assert.equal(body.totals.turns, 3);
  });

  await check('a missing projectPath is a 400 with a hint, not a crash', async () => {
    const response = await fetch(`${base}/session`);
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.code, 'MISSING_PROJECT_PATH');
    assert.ok(body.hint);
  });

  await check('an unknown route is a 404 listing the routes', async () => {
    const response = await fetch(`${base}/nope`);
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.equal(body.code, 'NOT_FOUND');
    assert.match(body.hint, /health/);
  });

  await check('a project with no transcripts lists nothing and names the searched directory', async () => {
    const { status, body } = await get(`/sessions?projectPath=${encodeURIComponent('D:\\nope\\nope')}`);
    // An empty project is a normal state, not an error: the UI renders its empty
    // state from the warning instead of an error banner.
    assert.equal(status, 200);
    assert.deepEqual(body.sessions, []);
    assert.ok(body.warnings[0].includes('.claude'), 'the warning names the directory that was searched');
  });

  await check('analysing a project with no transcripts is a 400 with a hint', async () => {
    const response = await fetch(`${base}/session?projectPath=${encodeURIComponent('D:\\nope\\nope')}`);
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.code, 'NO_TRANSCRIPTS');
    assert.ok(body.hint.includes('.claude'));
  });

  await check('GET /status returns a compact chip payload in one request', async () => {
    const { status, body } = await get(`/status?projectPath=${encodeURIComponent(PROJECT_PATH)}`);
    assert.equal(status, 200);
    assert.equal(body.available, true);
    assert.equal(body.turnCount, 3);
    assert.ok(Math.abs(body.hitRate - 27000 / 85000) < 1e-12);
    assert.equal(body.cacheRead, 27000);
    assert.equal(body.cacheCreation, 32800);
    assert.equal(body.breaks, 1);
    assert.equal(body.lostCachedTokens, 21000);
    assert.equal(body.model, 'claude-sonnet-4-5');
    assert.match(body.chipText, /^缓存命中 31\.8%$/, 'the chip label is ready to render');
    assert.match(body.detailText, /3 轮 · 缓存读 27\.0K/);
    assert.equal(body.truncated, false);
    assert.equal(typeof body.updatedAt, 'number');
  });

  await check('GET /status answers 200 with available:false instead of erroring', async () => {
    // A poller must not have to treat "no project yet" as a failure.
    const noProject = await get('/status');
    assert.equal(noProject.status, 200);
    assert.equal(noProject.body.available, false);
    assert.equal(noProject.body.chipText, '缓存命中 --');
    assert.equal(noProject.body.reason, '未选择项目');

    const noTranscripts = await get(`/status?projectPath=${encodeURIComponent('D:\\nope\\nope')}`);
    assert.equal(noTranscripts.status, 200);
    assert.equal(noTranscripts.body.available, false);
    assert.equal(noTranscripts.body.chipText, '缓存命中 --');
    // `reason` carries the underlying message so a tooltip can explain the blank chip.
    assert.match(noTranscripts.body.reason, /transcript/);
  });

  await check('GET /status is stable across polls (served from the analysis cache)', async () => {
    const first = await get(`/status?projectPath=${encodeURIComponent(PROJECT_PATH)}`);
    const second = await get(`/status?projectPath=${encodeURIComponent(PROJECT_PATH)}`);
    assert.equal(first.body.hitRate, second.body.hitRate);
    assert.equal(first.body.chipText, second.body.chipText);
    assert.equal(second.body.turnCount, 3);
  });

  await check('a relative projectPath is rejected', async () => {
    const response = await fetch(`${base}/session?projectPath=relative%2Fpath`);
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.code, 'INVALID_PROJECT_PATH');
  });

  await check('GET /clear-cache keeps the server usable', async () => {
    const { status, body } = await get('/clear-cache');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const after = await get(`/session?projectPath=${encodeURIComponent(PROJECT_PATH)}`);
    assert.equal(after.body.totals.turns, 3);
  });

  await check('the cache returns the same numbers on a second read', async () => {
    const first = await get(`/session?projectPath=${encodeURIComponent(PROJECT_PATH)}`);
    const second = await get(`/session?projectPath=${encodeURIComponent(PROJECT_PATH)}`);
    assert.equal(first.body.totals.promptTokens, second.body.totals.promptTokens);
    assert.equal(second.body.transcript.truncated, false);
  });

  await check('SIGTERM shuts the process down', async () => {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const result = await Promise.race([
      exited.then(() => 'exited'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 6000)),
    ]);
    assert.equal(result, 'exited', 'the host sends SIGTERM and allows 5s before SIGKILL');
    // The listener must really be gone.
    await assert.rejects(() => fetch(`${base}/health`));
  });

  if (child.exitCode === null) child.kill('SIGKILL');
  await fsp.rm(home, { recursive: true, force: true }).catch(() => {});

  console.log(failures === 0 ? '\nE2E: all checks passed' : `\nE2E: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('E2E harness error:', error);
  process.exit(1);
});
