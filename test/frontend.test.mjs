/**
 * Frontend render tests.
 *
 * The plugin's browser module is the one part TypeScript cannot fully protect:
 * the host hands it a live DOM and an `api` object, and a single bad reference
 * inside `mount()` shows up to the user as an error banner in the tab. These
 * tests mount the *compiled* module against a jsdom document and a fake host,
 * with real analysis output served through `api.rpc`, then assert what the user
 * would actually see.
 *
 * Run: npm test
 */

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { JSDOM } from 'jsdom';

import { summarizeSessionFile } from '../dist/analyze/summarize.js';
import { encodeProjectPath, listSessions } from '../dist/analyze/transcript.js';
import { buildOverview } from '../dist/analyze/summarize.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');

const PROJECT_PATH = 'D:\\demo\\ui';
const SESSION_ID = 'ui-session';
const BASE_MS = Date.parse('2026-05-02T09:00:00.000Z');

/** Overridden by `makeFixture(base)` so a test can place the session anywhere. */
let FIXTURE_BASE = BASE_MS;

function assistant(input, cacheRead, cacheCreation, output, offsetSeconds, model = 'claude-sonnet-4-5') {
  return {
    type: 'assistant',
    uuid: `u-${offsetSeconds}`,
    timestamp: new Date(FIXTURE_BASE + offsetSeconds * 1000).toISOString(),
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

async function makeFixture(base = BASE_MS) {
  FIXTURE_BASE = base;
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'cache-hit-ui-'));
  const directory = path.join(home, '.claude', 'projects', encodeProjectPath(PROJECT_PATH));
  await fsp.mkdir(directory, { recursive: true });
  const lines = [
    assistant(5000, 0, 20000, 100, 0),
    assistant(200, 24000, 800, 150, 30),
    assistant(20000, 3000, 12000, 200, 90),
    assistant(150, 34000, 900, 120, 120),
    assistant(140, 35000, 800, 130, 150, 'claude-opus-4-5'),
    // Cost checkpoint: 700 output / 14s API = exactly 50 tok/s.
    {
      type: 'cost-state',
      sessionId: SESSION_ID,
      timestamp: new Date(FIXTURE_BASE + 200 * 1000).toISOString(),
      totalCostUSD: 1,
      totalAPIDuration: 14000,
      totalAPIDurationWithoutRetries: 13000,
      totalToolDuration: 900,
      totalDuration: 300000,
      startTime: FIXTURE_BASE,
      hasUnknownModelCost: false,
      modelUsage: {
        'claude-sonnet-4-5': {
          inputTokens: 25490,
          outputTokens: 700,
          cacheReadInputTokens: 96000,
          cacheCreationInputTokens: 34500,
          webSearchRequests: 0,
          costUSD: 1,
        },
      },
    },
  ];
  const file = path.join(directory, `${SESSION_ID}.jsonl`);
  await fsp.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  return { home, directory, file };
}

/**
 * A fixture with `count` plain turns and nothing that trips break detection:
 * one model, monotonically non-decreasing cacheRead, so every rendered bar is a
 * turn (no red break markers to confuse a `轮次 #` count). Used to exercise the
 * per-turn chart's turn-window selector.
 */
async function makeTurnsFixture(count) {
  FIXTURE_BASE = BASE_MS;
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'cache-hit-ui-turns-'));
  const directory = path.join(home, '.claude', 'projects', encodeProjectPath(PROJECT_PATH));
  await fsp.mkdir(directory, { recursive: true });
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    // input 100, cacheRead grows, cacheCreation 200, output 50, 30s apart.
    lines.push(assistant(100, 10000 + i * 500, 200, 50, i * 30));
  }
  const file = path.join(directory, `${SESSION_ID}.jsonl`);
  await fsp.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  return { home, directory, file };
}

/** Boot a jsdom document and import the compiled plugin module into it. */
async function setupFrontend(home) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    url: 'https://cloudcli.local/',
    pretendToBeVisual: true,
  });

  // The module resolves `document` from the global scope at mount time.
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;

  const summary = await summarizeSessionFile({
    file: path.join(home, '.claude', 'projects', encodeProjectPath(PROJECT_PATH), `${SESSION_ID}.jsonl`),
    sessionId: SESSION_ID,
    projectPath: PROJECT_PATH,
    force: true,
  });
  const sessions = await listSessions(path.join(home, '.claude', 'projects', encodeProjectPath(PROJECT_PATH)));
  const overview = await buildOverview({ home, projectPath: PROJECT_PATH });

  const routes = [
    [/^health/, () => ({ ok: true, plugin: 'cache-hit', node: 'v22.0.0', pid: 1, home, claudeProjectsDirectory: path.join(home, '.claude', 'projects'), claudeProjectsExists: true, projectDirectories: 1, cacheEntries: 1, startedAt: Date.now() })],
    [/^sessions/, () => ({ projectPath: PROJECT_PATH, projectDirectory: path.join(home, '.claude', 'projects'), sessions, warnings: [] })],
    [/^session/, () => summary],
    [/^overview/, () => overview],
    [/^clear-cache/, () => ({ ok: true, cacheEntries: 0 })],
  ];

  const calls = [];
  const rpc = async (_method, route) => {
    calls.push(route);
    for (const [pattern, handler] of routes) {
      if (pattern.test(route)) return handler();
    }
    throw new Error(`RPC 404 ${route}`);
  };

  // The real host rebuilds this object on every change (`buildContext()` in
  // PluginTabContent.tsx) rather than mutating one in place.
  let context = {
    theme: 'dark',
    project: { name: 'proj-id-from-db', path: PROJECT_PATH },
    session: { id: 'app-session-id', title: 'App session' },
  };
  const listeners = new Set();
  const api = {
    get context() {
      return context;
    },
    onContextChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    rpc,
  };

  const module = await import(pathToFileURL(path.join(PLUGIN_ROOT, 'dist', 'index.js')).href);
  const container = dom.window.document.getElementById('host');

  const cleanup = () => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    dom.window.close();
  };

  return {
    dom,
    module,
    api,
    container,
    get context() {
      return context;
    },
    summary,
    calls,
    cleanup,
    emitContext(next) {
      // A fresh object each time, exactly like the host.
      context = {
        theme: next.theme ?? context.theme,
        project: 'project' in next ? next.project : context.project,
        session: 'session' in next ? next.session : context.session,
      };
      for (const listener of listeners) listener(context);
    },
    /** Mutate the live context object in place, as a defensive-host regression. */
    mutateContextInPlace(next) {
      Object.assign(context, next);
      for (const listener of listeners) listener(context);
    },
    listenerCount: () => listeners.size,
  };
}

/** Let pending microtasks and the mount-time async refresh settle. */
async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('mount renders the analysis without throwing', async () => {
  const home = (await makeFixture()).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();

    const html = front.container.innerHTML;
    assert.ok(html.length > 2000, 'a real panel was rendered');
    assert.ok(html.includes('缓存命中'), 'the title is present');
    assert.ok(html.includes('加权命中率'), 'the headline KPI is present');
    assert.ok(html.includes('缓存写入 Token'), 'the write bucket is present');
    assert.ok(html.includes('净节省'), 'the saving counterfactual is present');
    assert.ok(html.includes('逐轮命中率'), 'the per-turn chart section is present');
    assert.ok(html.includes('<svg'), 'the chart is real SVG');
    assert.ok(html.includes('解析明细'), 'the parsing breakdown is present');
    assert.ok(html.includes('计算口径'), 'the methodology disclosure is present');
    // The project label is derived from the path, never from the opaque DB id.
    assert.ok(html.includes('ui'), 'the project basename is shown');
    assert.ok(!html.includes('proj-id-from-db'), 'the opaque project id must not be shown as the name');
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('mount shows the hit rate, the break table and the raw JSONL line numbers', async () => {
  const home = (await makeFixture()).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();

    const html = front.container.innerHTML;
    // Fixture: input 25490, cacheRead 96000, cacheCreation 34500 -> 96000/155990.
    assert.ok(html.includes('61.5%'), `expected the weighted hit rate in the KPI row, got: ${html.slice(0, 400)}`);
    assert.ok(html.includes('缓存断裂'), 'the break section is rendered');
    assert.ok(html.includes('前缀变化'), 'the single break is attributed to a prefix change');
    assert.ok(html.includes('21,000'), 'the lost cached prefix is shown in full');
    assert.ok(html.includes('源码行'), 'the break points back at the transcript line');
    assert.ok(html.includes('claude-opus-4-5'), 'per-model rows are listed');
    assert.ok(html.includes('按模型'), 'the model table is present');
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('the output rate renders with its denominator stated, next to the hit rate', async () => {
  const home = (await makeFixture()).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();

    const html = front.container.innerHTML;
    assert.ok(html.includes('输出速率'), 'the rate KPI exists');
    assert.ok(html.includes('50 tok/s'), `expected the runtime-derived rate, got: ${html.slice(0, 300)}`);
    // The denominator is always on screen — a rate without its basis invites the
    // reader to assume a decode-only peak.
    assert.ok(html.includes('API 累计耗时'), 'the denominator is named');
    assert.ok(html.includes('不含工具执行'), 'and its exclusions are stated');
    assert.ok(html.includes('运行时累计命中率'), 'the runtime cross-check is shown separately');
    assert.ok(html.includes('cost-state 检查点'), 'and its provenance is shown');
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('mount requests only its own routes through api.rpc', async () => {
  const home = (await makeFixture()).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();
    assert.ok(front.calls.length >= 3, 'health, sessions and session were requested');
    for (const route of front.calls) {
      assert.ok(
        /^(health|sessions|session|overview|clear-cache)/.test(route),
        `unexpected route ${route}`,
      );
    }
    assert.ok(front.calls.some((route) => route.startsWith('session?')), 'the analysis route carries params');
    assert.ok(
      front.calls.some((route) => route.includes('projectPath=')),
      'the project path is forwarded from api.context',
    );
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('the overview scope renders the daily table and the break leaderboard', async () => {
  const home = (await makeFixture()).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();

    const overviewButton = Array.from(front.container.querySelectorAll('[data-scope]')).find(
      (element) => element.getAttribute('data-scope') === 'overview',
    );
    assert.ok(overviewButton, 'the overview tab exists');
    overviewButton.dispatchEvent(new front.dom.window.MouseEvent('click', { bubbles: true }));
    await settle();

    const html = front.container.innerHTML;
    assert.ok(html.includes('按日'), 'the daily table is rendered');
    assert.ok(front.calls.some((route) => route.startsWith('overview')), 'overview was requested');
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('a theme-only change re-renders without re-reading any transcript', async () => {
  const home = (await makeFixture()).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();
    const before = front.calls.length;

    front.emitContext({ theme: 'light' });
    await settle();

    assert.ok(front.container.innerHTML.includes('缓存命中'), 'the panel survives the re-render');
    assert.equal(front.calls.length, before, 'a theme flip must not re-read the transcript');
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('a session change triggers a re-read', async () => {
  const home = (await makeFixture()).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();
    const before = front.calls.length;

    front.emitContext({ session: { id: 'another-app-session', title: 'Other' } });
    await settle();

    assert.ok(front.calls.length > before, 'switching sessions must refresh the numbers');
    assert.ok(front.container.innerHTML.includes('缓存命中'));
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('a host that mutates its context object in place still triggers a refresh', async () => {
  const home = (await makeFixture()).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();
    const before = front.calls.length;

    // Regression guard: comparing context by object reference would see no change
    // here and keep displaying the previous project's numbers.
    front.mutateContextInPlace({ session: { id: 'mutated-session', title: 'Mutated' } });
    await settle();

    assert.ok(front.calls.length > before, 'the change is detected even when the object identity is reused');
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('unmount cleans up the timer and the context subscription', async () => {
  const home = (await makeFixture()).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();
    assert.equal(front.listenerCount(), 1, 'mount subscribes to context changes');

    front.module.unmount(front.container);
    assert.equal(front.container.innerHTML, '', 'the container is emptied');
    assert.equal(front.listenerCount(), 0, 'the subscription is released, or repeated mounts would leak');
    assert.equal(front.container._cacheHitCleanup, undefined, 'the cleanup hook is removed');

    const callsAfterUnmount = front.calls.length;
    await settle(3);
    assert.equal(front.calls.length, callsAfterUnmount, 'no refresh fires after unmount');
  } finally {
    front.cleanup();
  }
});

test('mounting twice on the same container does not double-subscribe', async () => {
  const home = (await makeFixture()).home;
  const front = await setupFrontend(home);
  try {
    // The host calls mount() on every activation of the tab.
    await front.module.mount(front.container, front.api);
    await settle();
    front.module.unmount(front.container);

    await front.module.mount(front.container, front.api);
    await settle();
    assert.equal(front.listenerCount(), 1, 'only one live subscription after a remount');
    assert.ok(front.container.innerHTML.includes('缓存命中'));
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('an RPC failure renders an error state instead of a blank tab', async () => {
  const home = (await makeFixture()).home;
  const front = await setupFrontend(home);
  try {
    const failing = { ...front.api, rpc: async () => { throw new Error('RPC error 503'); } };
    await front.module.mount(front.container, failing);
    await settle();
    const html = front.container.innerHTML;
    assert.ok(html.includes('分析失败'), 'the failure is surfaced to the user');
    assert.ok(html.includes('RPC error 503'), 'with the underlying reason');
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('no project selected renders guidance rather than an empty shell', async () => {
  const home = (await makeFixture()).home;
  const front = await setupFrontend(home);
  try {
    front.emitContext({ project: null });
    await front.module.mount(front.container, front.api);
    await settle();
    const html = front.container.innerHTML;
    assert.ok(html.includes('请在 CloudCLI 中选择一个项目'), 'the empty state explains what to do');
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('theme changes switch the palette without a reload', async () => {
  const home = (await makeFixture()).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();

    // The root element carries the palette; jsdom normalises colours in the CSSOM,
    // so match either the hex token or its rgb() form.
    const darkBackground = front.container.firstElementChild.style.background;
    assert.match(darkBackground, /#0d0d11|13,\s*13,\s*17/, `dark palette applied, got "${darkBackground}"`);

    front.emitContext({ theme: 'light' });
    await settle();
    const lightBackground = front.container.firstElementChild.style.background;
    assert.match(lightBackground, /#fafaf8|250,\s*250,\s*248/, `light palette applied, got "${lightBackground}"`);
    assert.notEqual(darkBackground, lightBackground);
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('timestamps always carry a date, so a resumed session is placeable in time', async () => {
  // Regression: the break table showed `11:47:09` and the metadata card showed
  // `10:58 → 11:01`. A transcript resumed days later, or a session crossing
  // midnight, becomes unreadable that way — you cannot tell which day it was.
  const home = (await makeFixture()).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();

    const html = front.container.innerHTML;
    const stamped = /(\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;

    // The break table's 时间 cell.
    const breakTable = Array.from(front.container.querySelectorAll('.ch-table')).find((table) =>
      (table.querySelector('thead')?.textContent ?? '').includes('归因'),
    );
    assert.ok(breakTable, 'the break table is rendered');
    const timeCells = Array.from(breakTable.querySelectorAll('tbody tr')).map((row) => row.children[1]?.textContent?.trim() ?? '');
    assert.ok(timeCells.length > 0, 'the fixture produced at least one break');
    for (const cell of timeCells) {
      assert.match(cell, stamped, `break time "${cell}" must carry a date`);
    }

    // The session metadata range.
    const range = /(\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}/;
    assert.ok(range.test(html), 'the session time range must carry a date');

    // The session picker: a relative age ("47 天前") is exactly the case where
    // the reader needs a calendar date.
    assert.ok(!/\d+ 天前/.test(html), 'the picker must not fall back to a bare relative age');
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('a range crossing midnight dates both ends', async () => {
  // Built from LOCAL components so the assertion holds in any timezone: the
  // session starts at local 23:58 and its last turn lands at 00:00:30 the next
  // day. A range rendered as `23:58:00 → 00:00:30` would be actively misleading.
  const start = new Date(2026, 4, 2, 23, 58, 0).getTime();
  const home = (await makeFixture(start)).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();

    const html = front.container.innerHTML;
    assert.ok(
      html.includes('05-02 23:58:00 → 05-03 00:00:30'),
      'a range that crosses midnight must date both ends, otherwise it reads as going backwards',
    );

    // The single break in the fixture sits at +90s, still before midnight.
    const breakTable = Array.from(front.container.querySelectorAll('.ch-table')).find((table) =>
      (table.querySelector('thead')?.textContent ?? '').includes('归因'),
    );
    const cell = breakTable?.querySelector('tbody tr')?.children[1]?.textContent?.trim() ?? '';
    assert.equal(cell, '05-02 23:59:30', `the break cell must carry its own date, got "${cell}"`);
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('numeric table headers are right-aligned like their values', async () => {
  // Regression: `.ch-table th` is specificity (0,1,1) and silently outranked the
  // bare `.ch-num` (0,1,0), so every numeric header stayed left-aligned while its
  // column's values hugged the right edge — the whole table read as shifted.
  // Measured in Chrome before/after: th computed `text-align: left` against a
  // `text-align: right` td, then `right`/`right` once the rule was restated at
  // equal specificity. jsdom does no layout, so this asserts the two invariants
  // that made it fail rather than the rendered pixels.
  const home = (await makeFixture()).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();

    const style = front.dom.window.document.getElementById('cache-hit-styles');
    assert.ok(style, 'the stylesheet is injected');
    // Strip comments first: they sit in the same chunk as the following selector
    // and would otherwise be matched as part of it.
    const css = (style.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '');

    // (a) A right-align rule that can actually win over `.ch-table th`.
    const rules = css
      .split('}')
      .map((chunk) => chunk.split('{'))
      .filter((parts) => parts.length === 2)
      .map(([selector, body]) => ({ selector: selector.trim(), body: body.trim() }));
    const winning = rules.filter(
      (rule) => /th\.ch-num\b/.test(rule.selector) && /text-align:\s*right/.test(rule.body),
    );
    assert.ok(
      winning.length > 0,
      'the stylesheet must restate right-alignment for th.ch-num, or headers lose to `.ch-table th`',
    );

    // (b) Every numeric column's header carries the class. A table added with a
    //     `ch-num` body cell and a plain `<th>` would regress silently.
    const tables = front.container.querySelectorAll('.ch-table');
    assert.ok(tables.length > 0, 'at least one table is rendered');
    let numericColumns = 0;
    for (const table of tables) {
      const headRow = table.querySelector('thead tr');
      const bodyRow = table.querySelector('tbody tr');
      if (!headRow || !bodyRow) continue;
      const heads = headRow.children;
      const cells = bodyRow.children;
      for (let i = 0; i < cells.length; i += 1) {
        if (!cells[i]?.classList.contains('ch-num')) continue;
        numericColumns += 1;
        assert.ok(
          heads[i]?.classList.contains('ch-num'),
          `column ${i} ("${heads[i]?.textContent?.trim()}") has a ch-num value cell but its header does not`,
        );
      }
    }
    assert.ok(numericColumns >= 6, `expected the numeric columns to be covered, saw ${numericColumns}`);
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('the parsing breakdown keeps its numbers in one aligned column', async () => {
  // Regression: the value and its note shared a single right-aligned cell, so each
  // value was pushed left by the width of its own note and rows with a note never
  // lined up with rows without one. The fix gives the value its own grid track.
  const home = (await makeFixture()).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();

    const grid = front.container.querySelector('.ch-kv3');
    assert.ok(grid, 'the breakdown uses the three-track grid');
    const children = Array.from(grid.children);
    assert.ok(children.length > 0 && children.length % 3 === 0, `label/value/note triples, got ${children.length} cells`);
    for (let i = 0; i < children.length; i += 3) {
      assert.ok(children[i + 1]?.classList.contains('ch-num'), `row ${i / 3} value cell is right-aligned in its own track`);
      assert.notEqual(children[i + 1], children[i + 2], 'the note lives in its own track, not inside the value cell');
    }
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('icon.svg survives the host SVG sanitizer and adapts to the tab theme', async () => {
  // The host renders plugin icons by fetching the file and passing it through
  // DOMPurify with a restricted SVG profile (`src/modules/plugins/PluginIcon.tsx`).
  // A forbidden tag or attribute silently degrades the tab to an empty icon.
  const FORBIDDEN_SVG_TAGS = [
    'script',
    'foreignObject',
    'iframe',
    'object',
    'embed',
    'link',
    'meta',
    'style',
    'animate',
    'set',
    'animateTransform',
    'animateMotion',
  ];
  const FORBIDDEN_SVG_ATTRS = ['href', 'xlink:href', 'src', 'style'];

  const svgText = await fsp.readFile(path.join(PLUGIN_ROOT, 'icon.svg'), 'utf8');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  try {
    const doc = new dom.window.DOMParser().parseFromString(svgText, 'image/svg+xml');
    assert.equal(doc.documentElement.nodeName, 'svg', 'the root element must be <svg>');
    assert.equal(doc.querySelector('parsererror'), null, 'the file must be valid SVG XML');
    assert.ok(doc.querySelectorAll('rect').length >= 3, 'the icon actually has shapes');

    for (const element of [doc.documentElement, ...doc.querySelectorAll('*')]) {
      assert.ok(!FORBIDDEN_SVG_TAGS.includes(element.nodeName), `forbidden SVG tag ${element.nodeName}`);
      for (const attribute of element.getAttributeNames()) {
        assert.ok(!FORBIDDEN_SVG_ATTRS.includes(attribute), `forbidden SVG attribute ${attribute}`);
      }
    }
    // currentColor lets the icon inherit the active tab's foreground in both themes.
    assert.ok(svgText.includes('currentColor'), 'the icon must adapt to the theme');
  } finally {
    dom.window.close();
  }
});

test('the cached (purple) bar lets the hover tooltip fall through to the total bar', async () => {
  const home = (await makeTurnsFixture(12)).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();

    const html = front.container.innerHTML;
    assert.ok(html.includes('轮次 #'), 'the grey total bar carries the per-turn <title> tooltip');

    // Dark theme accent = #7c6cf0 (the purple cached overlay). It sits on top of
    // the titled grey bar, so it MUST be click-through or hovering the purple
    // region surfaces no tooltip — the exact bug being fixed.
    const purple = Array.from(front.container.querySelectorAll('svg rect')).filter(
      (rect) => rect.getAttribute('fill') === '#7c6cf0',
    );
    assert.ok(purple.length > 0, 'the chart actually drew cached (purple) overlay bars');
    for (const rect of purple) {
      assert.equal(
        rect.getAttribute('pointer-events'),
        'none',
        'the purple cached bar must not swallow the hover',
      );
    }
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('the per-turn chart defaults to the last 10 turns and the selector rescopes the window', async () => {
  const home = (await makeTurnsFixture(35)).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();

    const turnCount = () => (front.container.innerHTML.match(/轮次 #/g) || []).length;

    // Default window: the most recent 10 of 35 turns, i.e. #26 → #35.
    assert.equal(turnCount(), 10, 'the chart defaults to 10 turns');
    assert.ok(front.container.innerHTML.includes('>#26<'), 'the default window starts at turn #26');
    assert.ok(front.container.innerHTML.includes('>#35<'), 'and ends at the newest turn #35');

    const callsBefore = front.calls.length;

    const to = (value) => {
      const select = front.container.querySelector('#ch-turns');
      assert.ok(select, 'the turn-window selector is present');
      select.value = value;
      select.dispatchEvent(new front.dom.window.Event('change', { bubbles: true }));
    };

    to('30');
    await settle();
    assert.equal(turnCount(), 30, 'selecting 30 shows the most recent 30 turns');
    assert.ok(front.container.innerHTML.includes('>#6<'), 'the 30-turn window starts at #6');

    to('all');
    await settle();
    assert.equal(turnCount(), 35, 'selecting 全部 shows every turn');
    assert.ok(front.container.innerHTML.includes('>#1<'), 'the full window starts at #1');

    // Rescoping is a pure view change — it must not re-read the transcript.
    assert.equal(front.calls.length, callsBefore, 'changing the window issues no new RPC');
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

/** The per-turn detail table, isolated from the per-model table by its 速度 column. */
function turnLogTable(container) {
  const tables = Array.from(container.querySelectorAll('table.ch-table'));
  return tables.find((t) => (t.querySelector('thead')?.textContent || '').includes('速度')) ?? null;
}

test('the per-turn detail table lists newest-first and paginates 10 per page by default', async () => {
  const home = (await makeTurnsFixture(35)).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();

    assert.ok(front.container.innerHTML.includes('逐轮明细（35）'), 'the section header shows the turn count');

    const rows = () => turnLogTable(front.container).querySelectorAll('tbody tr');
    assert.equal(rows().length, 10, 'the table defaults to 10 rows per page');
    assert.ok(rows()[0].textContent.includes('#35'), 'the newest turn is first');
    assert.ok(rows()[9].textContent.includes('#26'), 'and the page ends at #26');
    assert.ok(front.container.innerHTML.includes('第 1 / 4 页'), '35 turns at 10/page is 4 pages');

    // Numeric headers must be right-aligned to match their values (the project's
    // hard alignment rule, otherwise the whole table reads as shifted).
    const speedTh = Array.from(turnLogTable(front.container).querySelectorAll('th')).find(
      (th) => th.textContent.trim() === '速度',
    );
    assert.ok(speedTh?.classList.contains('ch-num'), 'the 速度 header is right-aligned (ch-num)');

    const callsBefore = front.calls.length;

    front.container.querySelector('#ch-turnlog-next').dispatchEvent(
      new front.dom.window.MouseEvent('click', { bubbles: true }),
    );
    await settle();
    assert.ok(rows()[0].textContent.includes('#25'), 'page 2 starts at #25');
    assert.ok(front.container.innerHTML.includes('第 2 / 4 页'), 'the pager advanced to page 2');

    const sizeTo = (value) => {
      const select = front.container.querySelector('#ch-turnlog-size');
      assert.ok(select, 'the page-size selector exists');
      select.value = value;
      select.dispatchEvent(new front.dom.window.Event('change', { bubbles: true }));
    };

    sizeTo('20');
    await settle();
    assert.equal(rows().length, 20, '20/page shows 20 rows');
    assert.ok(rows()[0].textContent.includes('#35'), 'changing the page size resets to the newest page');
    assert.ok(front.container.innerHTML.includes('第 1 / 2 页'), '35 turns at 20/page is 2 pages');

    sizeTo('all');
    await settle();
    assert.equal(rows().length, 35, '全部 shows every turn on one page');
    assert.ok(front.container.innerHTML.includes('共 35 轮'), 'the 全部 view states the total');

    assert.equal(front.calls.length, callsBefore, 'paginating issues no new RPC');
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});

test('the per-turn speed is wall-clock, labelled, and null on the first turn', async () => {
  const home = (await makeTurnsFixture(12)).home;
  const front = await setupFrontend(home);
  try {
    await front.module.mount(front.container, front.api);
    await settle();

    const html = front.container.innerHTML;
    assert.ok(html.includes('速度 = 本轮 output'), 'the speed basis is spelled out');
    assert.ok(html.includes('不是解码速度'), 'and it is explicitly not a decode rate');

    // Show every turn so #1 (which has no previous turn) is on the page.
    const select = front.container.querySelector('#ch-turnlog-size');
    select.value = 'all';
    select.dispatchEvent(new front.dom.window.Event('change', { bubbles: true }));
    await settle();

    const rows = turnLogTable(front.container).querySelectorAll('tbody tr');
    assert.equal(rows.length, 12, 'all 12 turns are shown');

    // Columns: 轮次 | 时间 | 模型 | 命中率 | 速度 | 缓存读 | 缓存写 | 成本.
    const speedCell = (row) => row.querySelectorAll('td')[4].textContent.trim();
    const first = rows[0]; // newest, #12
    const last = rows[11]; // oldest, #1
    assert.ok(last.textContent.includes('#1'), 'the last row is the first turn');
    assert.equal(speedCell(last), '--', 'the first turn has no previous turn, so no wall-clock rate');
    // 50 output over a 30s gap -> 1.7 tok/s.
    assert.equal(speedCell(first), '1.7', 'later turns show output ÷ wall-clock gap');
  } finally {
    front.module.unmount(front.container);
    front.cleanup();
  }
});
