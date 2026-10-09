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

async function makeFixture() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'cache-hit-ui-'));
  const directory = path.join(home, '.claude', 'projects', encodeProjectPath(PROJECT_PATH));
  await fsp.mkdir(directory, { recursive: true });
  const lines = [
    assistant(5000, 0, 20000, 100, 0),
    assistant(200, 24000, 800, 150, 30),
    assistant(20000, 3000, 12000, 200, 90),
    assistant(150, 34000, 900, 120, 120),
    assistant(140, 35000, 800, 130, 150, 'claude-opus-4-5'),
  ];
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
