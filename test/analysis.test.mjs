/**
 * Deterministic regression tests for the analysis core.
 *
 * Runs entirely in-process against the compiled `dist/analyze/*.js` — no HTTP, no
 * child processes, no network, no real user state. A synthetic transcript is
 * written into a temp directory, and every assertion pins one of the cc-haha
 * accounting rules the plugin claims to implement.
 *
 * Run: npm test   (after npm run build)
 */

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { detectBreaks } from '../dist/analyze/breaks.js';
import { formatCacheHitRate, hitRateOf, summarizeTotals, turnCost } from '../dist/analyze/metrics.js';
import { actualCostUSD, noCacheCostUSD, resolveModelRates } from '../dist/analyze/pricing.js';
import { extractTurns, summarizeSessionFile } from '../dist/analyze/summarize.js';
import { encodeProjectPath, parseTranscript } from '../dist/analyze/transcript.js';
import { normalizeUsage, usageRecordKey } from '../dist/analyze/usage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');

const PROJECT_PATH = 'D:\\demo\\proj';
const SESSION_ID = 'sess-0001';
const BASE_MS = Date.parse('2026-03-01T10:00:00.000Z');

/* ── Fixture ─────────────────────────────────────────────────────────────── */

let messageCounter = 0;

/**
 * One assistant transcript line. Claude Code writes one line per content block
 * and repeats the whole `usage` object on every one of them, which is exactly
 * what the dedupe assertions below exercise.
 */
function assistantLine(options) {
  messageCounter += 1;
  const {
    input = 0,
    output = 0,
    cacheRead = 0,
    cacheCreation = 0,
    model = 'claude-sonnet-4-5',
    offsetSeconds = 0,
    requestId = `req-${messageCounter}`,
    messageId = `msg-${messageCounter}`,
    sidechain = false,
    forked = false,
    zero = false,
  } = options;

  const line = {
    type: 'assistant',
    uuid: `uuid-${messageCounter}`,
    timestamp: new Date(BASE_MS + offsetSeconds * 1000).toISOString(),
    sessionId: SESSION_ID,
    requestId,
    version: '1.0.24',
    message: {
      id: messageId,
      model,
      role: 'assistant',
      content: [{ type: 'text', text: `turn ${messageCounter}` }],
      usage: zero
        ? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        : {
            input_tokens: input,
            output_tokens: output,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheCreation,
          },
    },
  };
  if (sidechain) line.isSidechain = true;
  if (forked) line.forkedFrom = { sessionId: 'origin-session', messageUuid: 'origin-uuid' };
  return line;
}

function compactBoundaryLine(offsetSeconds) {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: `compact-${offsetSeconds}`,
    timestamp: new Date(BASE_MS + offsetSeconds * 1000).toISOString(),
    compactMetadata: { trigger: 'auto', preTokens: 150000 },
  };
}

/**
 * The scenario. Each row exists to pin one rule; the totals are asserted below.
 *
 *   T0  cold start                     prompt 25000, hit 0
 *   T1  first real hit                 prompt 25000, hit 0.96
 *   +3  duplicate content-block lines   must be deduped (the 2.2x trap)
 *   T2  steady state                   prompt 25500
 *   +1  sidechain (sub-agent)          excluded
 *   +1  all-zero `<synthetic>` usage   skipped
 *   +1  forkedFrom inherited line      excluded
 *   T3  prefix changed                 drop 21500, prompt +9500  -> prefix_changed
 *   T4  model switched to opus         drop 2000 exactly         -> model_changed
 *   T5  rebuilt
 *   T6  6 minute gap                   drop 32000               -> ttl_5m
 *   T7  rebuilt
 *   T8  70 minute gap                  drop 29500               -> ttl_1h
 *   T9  rebuilt
 *   --  compact_boundary
 *   T10 post-compaction drop           suppressed (expected)
 *   T11 rebuilt
 *   T12 small gap, prompt unchanged    drop 20000               -> server_side
 *   T13 rebuilt
 *   T14 haiku drop                     suppressed (cc-haha excludes haiku)
 */
function buildFixtureLines() {
  const lines = [];

  lines.push(assistantLine({ input: 5000, cacheCreation: 20000, output: 100, offsetSeconds: 0 })); // T0
  const t1 = assistantLine({ input: 200, cacheRead: 24000, cacheCreation: 800, output: 150, offsetSeconds: 30 }); // T1
  lines.push(t1);
  // Same message.id + requestId: three more content blocks of the same reply.
  for (let i = 0; i < 3; i += 1) {
    const clone = JSON.parse(JSON.stringify(t1));
    clone.uuid = `uuid-dup-${i}`;
    clone.message.content = [{ type: 'text', text: `block ${i}` }];
    lines.push(clone);
  }
  lines.push(assistantLine({ input: 300, cacheRead: 24500, cacheCreation: 700, output: 120, offsetSeconds: 60 })); // T2
  lines.push(assistantLine({ input: 100, cacheRead: 90000, output: 50, offsetSeconds: 65, sidechain: true }));
  lines.push(assistantLine({ offsetSeconds: 70, zero: true }));
  lines.push(assistantLine({ input: 100, cacheRead: 50000, output: 50, offsetSeconds: 75, forked: true }));

  lines.push(assistantLine({ input: 20000, cacheRead: 3000, cacheCreation: 12000, output: 200, offsetSeconds: 120 })); // T3
  lines.push(
    assistantLine({ input: 30000, cacheRead: 1000, cacheCreation: 5000, output: 300, model: 'claude-opus-4-5', offsetSeconds: 150 }),
  ); // T4
  lines.push(
    assistantLine({ input: 500, cacheRead: 34000, cacheCreation: 2000, output: 200, model: 'claude-opus-4-5', offsetSeconds: 180 }),
  ); // T5
  lines.push(
    assistantLine({ input: 1000, cacheRead: 2000, cacheCreation: 30000, output: 200, model: 'claude-opus-4-5', offsetSeconds: 180 + 360 }),
  ); // T6
  lines.push(
    assistantLine({ input: 500, cacheRead: 30000, cacheCreation: 1500, output: 150, model: 'claude-opus-4-5', offsetSeconds: 180 + 360 + 30 }),
  ); // T7
  lines.push(
    assistantLine({ input: 1000, cacheRead: 500, cacheCreation: 28000, output: 150, model: 'claude-opus-4-5', offsetSeconds: 180 + 360 + 30 + 4200 }),
  ); // T8
  lines.push(
    assistantLine({ input: 500, cacheRead: 28000, cacheCreation: 1000, output: 100, model: 'claude-opus-4-5', offsetSeconds: 180 + 360 + 30 + 4200 + 30 }),
  ); // T9

  lines.push(compactBoundaryLine(180 + 360 + 30 + 4200 + 60));

  lines.push(
    assistantLine({ input: 2000, cacheRead: 500, cacheCreation: 20000, output: 200, model: 'claude-opus-4-5', offsetSeconds: 180 + 360 + 30 + 4200 + 100 }),
  ); // T10
  lines.push(
    assistantLine({ input: 500, cacheRead: 21000, cacheCreation: 1000, output: 150, model: 'claude-opus-4-5', offsetSeconds: 180 + 360 + 30 + 4200 + 130 }),
  ); // T11
  lines.push(
    assistantLine({ input: 120, cacheRead: 1000, cacheCreation: 21000, output: 150, model: 'claude-opus-4-5', offsetSeconds: 180 + 360 + 30 + 4200 + 170 }),
  ); // T12
  lines.push(
    assistantLine({ input: 500, cacheRead: 22000, cacheCreation: 1000, output: 150, model: 'claude-opus-4-5', offsetSeconds: 180 + 360 + 30 + 4200 + 200 }),
  ); // T13
  lines.push(
    assistantLine({ input: 5000, cacheRead: 1000, cacheCreation: 20000, output: 100, model: 'claude-3-5-haiku-20241022', offsetSeconds: 180 + 360 + 30 + 4200 + 230 }),
  ); // T14

  return lines;
}

async function writeFixture() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'cache-hit-test-'));
  const directory = path.join(home, '.claude', 'projects', encodeProjectPath(PROJECT_PATH));
  await fsp.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${SESSION_ID}.jsonl`);
  await fsp.writeFile(file, `${buildFixtureLines().map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  return { home, directory, file };
}

async function analyseFixture() {
  const fixture = await writeFixture();
  const summary = await summarizeSessionFile({
    file: fixture.file,
    sessionId: SESSION_ID,
    projectPath: PROJECT_PATH,
    force: true,
  });
  return { fixture, summary };
}

/* ── Rule: bucket semantics ──────────────────────────────────────────────── */

test('normalizeUsage keeps the three prompt buckets disjoint', () => {
  const usage = normalizeUsage({ input_tokens: 200, cache_read_input_tokens: 24000, cache_creation_input_tokens: 800 });
  assert.equal(usage.input, 200);
  assert.equal(usage.cacheRead, 24000);
  assert.equal(usage.cacheCreation, 800);
  assert.equal(usage.input + usage.cacheRead + usage.cacheCreation, 25000);
});

test('normalizeUsage subtracts INCLUSIVE nested cached tokens (OpenAI-compatible gateways)', () => {
  // prompt_tokens_details.cached_tokens is included in prompt_tokens, so summing
  // it again would double-count every cache hit.
  const usage = normalizeUsage({ prompt_tokens: 10000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 8000 } });
  assert.equal(usage.cacheRead, 8000);
  assert.equal(usage.input, 2000, 'input must exclude the cached part');
  assert.equal(usage.input + usage.cacheRead, 10000);
  assert.equal(usage.translated, true);
});

test('normalizeUsage prefers the 5m/1h split over the aggregate cache_creation field', () => {
  const usage = normalizeUsage({
    input_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 700, ephemeral_1h_input_tokens: 300 },
  });
  assert.equal(usage.cacheCreation, 1000);
  assert.equal(usage.cacheCreation5m, 700);
  assert.equal(usage.cacheCreation1h, 300);
});

test('hit rate uses the prompt total as denominator, never the raw input', () => {
  assert.equal(hitRateOf({ input: 200, output: 0, cacheRead: 24000, cacheCreation: 800 }), 24000 / 25000);
  assert.equal(hitRateOf({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }), null, 'no prompt means no rate, not 0');
});

/* ── Rule: honest formatting ─────────────────────────────────────────────── */

test('a partial hit is never rounded up to a flat 100%', () => {
  assert.equal(formatCacheHitRate(1), '100%');
  assert.equal(formatCacheHitRate(0.9996), '99.96%');
  assert.equal(formatCacheHitRate(0.99999), '99.99%');
  assert.equal(formatCacheHitRate(0.96), '96.0%');
  assert.equal(formatCacheHitRate(0), '0%');
  assert.equal(formatCacheHitRate(null), '0%');
});

/* ── Rule: dedupe + exclusions ───────────────────────────────────────────── */

test('usageRecordKey dedupes one reply split across content blocks', () => {
  const key = usageRecordKey({ messageId: 'msg-1', requestId: 'req-1' });
  assert.equal(key, 'msg-1\u0000req-1');
  assert.equal(key, usageRecordKey({ messageId: 'msg-1', requestId: 'req-1' }));
  assert.notEqual(key, usageRecordKey({ messageId: 'msg-1', requestId: 'req-2' }));
  assert.equal(usageRecordKey({ requestId: 'req-1' }), null, 'no message id means nothing to dedupe on');
});

test('extractTurns counts every exclusion instead of dropping it silently', () => {
  const lines = buildFixtureLines();
  const parsed = parseTranscript(lines.map((line) => JSON.stringify(line)).join('\n'), false);
  const { turns, counts, compactionBoundaries } = extractTurns(parsed);

  assert.equal(turns.length, 15, 'the 15 countable main-thread turns');
  assert.equal(counts.duplicateRows, 3, 'the three extra content-block lines of reply T1');
  assert.equal(counts.sidechainRows, 1);
  assert.equal(counts.zeroUsageRows, 1);
  assert.equal(counts.forkedRows, 1);
  assert.equal(counts.malformedLines, 0);
  assert.equal(counts.usageRows, 21, 'every assistant line carrying a usage object');
  assert.equal(compactionBoundaries, 1);
});

test('normalizeUsage handles a malformed nested cache count without going negative', () => {
  const usage = normalizeUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 500 } });
  assert.equal(usage.cacheRead, 100, 'capped at the reported input');
  assert.equal(usage.input, 0);
});

/* ── Rule: session totals ────────────────────────────────────────────────── */

test('session totals match the hand-computed fixture', async () => {
  const { summary } = await analyseFixture();
  const t = summary.totals;

  assert.equal(t.input, 67120);
  assert.equal(t.cacheRead, 192500);
  assert.equal(t.cacheCreation, 164000);
  assert.equal(t.output, 2420);
  assert.equal(t.promptTokens, 67120 + 192500 + 164000);
  assert.equal(t.newTokens, 67120 + 2420, 'cache reads are not new spend');
  assert.equal(t.turns, 15);
  assert.ok(Math.abs(t.hitRate - 192500 / 423620) < 1e-12);
  assert.notEqual(t.hitRate, t.meanTurnHitRate, 'weighted and mean rates must stay distinct');
});

test('cost separates actual, no-cache counterfactual and net saving', async () => {
  const { summary } = await analyseFixture();
  const t = summary.totals;

  assert.ok(t.cost.actualUSD !== null && t.cost.actualUSD > 0);
  assert.ok(t.cost.noCacheUSD !== null && t.cost.noCacheUSD > t.cost.actualUSD, 'caching must have paid off in this fixture');
  assert.ok(Math.abs((t.cost.noCacheUSD - t.cost.actualUSD) - t.cost.savedUSD) < 1e-12);
  assert.ok(t.cost.wastedWriteUSD > 0, 'the write premium over the cache-read rate is reported');
});

test('pricing refuses to guess for an unknown model', () => {
  assert.equal(resolveModelRates('glm-4.6'), null);
  assert.equal(actualCostUSD('deepseek-chat', { input: 1000, output: 10, cacheRead: 0, cacheCreation: 0 }), null);
  assert.equal(noCacheCostUSD('some-unknown-model', { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }), null);
  // Longest prefix wins: 1M-context variants and snapshots still resolve.
  assert.equal(resolveModelRates('claude-opus-4-5-20251101'), resolveModelRates('claude-opus-4-5'));
  assert.equal(resolveModelRates('anthropic/claude-sonnet-4-5'), resolveModelRates('claude-sonnet-4-5'));
  assert.notEqual(resolveModelRates('claude-opus-4-5'), resolveModelRates('claude-sonnet-4-5'));
});

test('unpriceable models stay in the tokens but out of the cost total', async () => {
  const lines = buildFixtureLines();
  const parsed = parseTranscript(lines.map((line) => JSON.stringify(line)).join('\n'), false);
  const { turns } = extractTurns(parsed);
  const totals = summarizeTotals(
    turns.map((turn) => ({ ...turn, model: 'glm-4.6', cost: turnCost('glm-4.6', turn) })),
  );
  assert.ok(totals.promptTokens > 0, 'tokens are still counted');
  assert.equal(totals.cost.actualUSD, null, 'and no dollars are invented');
  assert.equal(totals.cost.savedUSD, null);
});

/* ── Rule: cache break detection & attribution ───────────────────────────── */

test('breaks fire on the cc-haha rule and are attributed in the expected order', async () => {
  const { summary } = await analyseFixture();
  const causes = summary.breaks.map((brk) => brk.cause);
  assert.deepEqual(causes, ['prefix_changed', 'model_changed', 'ttl_5m', 'ttl_1h', 'server_side']);
  assert.deepEqual(
    summary.breaks.map((brk) => brk.turnIndex),
    [3, 4, 6, 8, 12],
  );
});

test('the 5% / 2000-token threshold is what gates a break', async () => {
  const { summary } = await analyseFixture();
  for (const brk of summary.breaks) {
    assert.ok(brk.lostCachedTokens >= 2000, 'absolute drop must clear MIN_CACHE_MISS_TOKENS');
    assert.ok(brk.cacheRead < brk.previousCacheRead * 0.95, 'relative drop must clear 5%');
  }
  // T4 was constructed to sit exactly on the 2000-token floor.
  const modelChange = summary.breaks.find((brk) => brk.cause === 'model_changed');
  assert.equal(modelChange.lostCachedTokens, 2000);
});

test('cacheRead is reported as the matched-prefix length', async () => {
  const { summary } = await analyseFixture();
  const prefixChange = summary.breaks.find((brk) => brk.cause === 'prefix_changed');
  assert.equal(prefixChange.previousCacheRead, 24500);
  assert.equal(prefixChange.cacheRead, 3000);
  assert.equal(prefixChange.prefixMatchedTokens, 3000);
  assert.equal(prefixChange.promptDelta, 35000 - 25500);
  assert.ok(prefixChange.detail.includes('3,000'), 'the matched-prefix length is quoted in the explanation');
  assert.ok(prefixChange.detail.includes('前缀'), 'and so is the divergence framing');
});

test('post-compaction drops are suppressed, not reported', async () => {
  const { summary } = await analyseFixture();
  assert.ok(
    !summary.breaks.some((brk) => brk.turnIndex === 10),
    'the turn right after compact_boundary must not be a break',
  );
  assert.ok(summary.warnings.some((w) => w.includes('压缩')));
});

test('haiku drops are excluded, matching cc-haha', async () => {
  const { summary } = await analyseFixture();
  assert.ok(!summary.breaks.some((brk) => brk.model.includes('haiku')), 'haiku must not produce breaks');
  assert.ok(summary.warnings.some((w) => w.includes('haiku')));
});

test('a cold start is not a break', () => {
  const base = { line: 1, timestamp: BASE_MS, model: 'claude-opus-4-5', afterCompaction: false, cost: { actualUSD: null, noCacheUSD: null, savedUSD: null, wastedWriteUSD: null } };
  const { breaks } = detectBreaks([
    { ...base, index: 0, input: 5000, output: 100, cacheRead: 0, cacheCreation: 20000, promptTokens: 25000, newTokens: 5100, hitRate: 0 },
    { ...base, index: 1, line: 2, input: 200, output: 150, cacheRead: 24000, cacheCreation: 800, promptTokens: 25000, newTokens: 350, hitRate: 0.96 },
  ]);
  assert.equal(breaks.length, 0, 'the first hit after an uncached turn is not a regression');
});

/* ── Rule: discovery ─────────────────────────────────────────────────────── */

test('project directory encoding matches Claude Code / the CloudCLI host', () => {
  assert.equal(encodeProjectPath('D:\\WorkDemo\\my.app'), 'D--WorkDemo-my-app');
  assert.equal(encodeProjectPath('/home/me/proj'), '-home-me-proj');
  assert.equal(encodeProjectPath('/a/b_c-d'), '-a-b-c-d');
});

test('transcript parsing survives a half-written final line', () => {
  const text = '{"type":"assistant"}\n{"type":"assist';
  const parsed = parseTranscript(text, false);
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.malformed, 1, 'counted, never thrown');
});

test('a tail read discards the leading partial line', () => {
  const parsed = parseTranscript('alf-line garbage\n{"type":"assistant"}\n', true);
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.malformed, 0);
});

/* ── Host contract ───────────────────────────────────────────────────────── */

test('the compiled frontend entry has no import statement (host loads it from a Blob URL)', async () => {
  const source = await fsp.readFile(path.join(PLUGIN_ROOT, 'dist', 'index.js'), 'utf8');
  const imports = source.match(/^\s*import[\s{'"]/gm) ?? [];
  assert.deepEqual(imports, [], 'a runtime relative import would resolve against blob: and fail at mount');
  assert.ok(source.includes('export function mount'));
  assert.ok(source.includes('export function unmount'));
});

test('the manifest satisfies the host validator', async () => {
  const manifest = JSON.parse(await fsp.readFile(path.join(PLUGIN_ROOT, 'manifest.json'), 'utf8'));
  assert.match(manifest.name, /^[a-zA-Z0-9_-]+$/);
  assert.equal(typeof manifest.displayName, 'string');
  assert.equal(typeof manifest.entry, 'string');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.slot, 'tab');
  await fsp.access(path.join(PLUGIN_ROOT, manifest.entry));
  await fsp.access(path.join(PLUGIN_ROOT, manifest.server));
});

test('the plugin never writes to the host or user state', async () => {
  const files = ['analyze/transcript.js', 'analyze/summarize.js', 'server.js', 'index.js'];
  for (const relative of files) {
    const source = await fsp.readFile(path.join(PLUGIN_ROOT, 'dist', relative), 'utf8');
    for (const forbidden of ['writeFile', 'mkdir', 'rmSync', 'unlink', 'appendFile', 'createWriteStream']) {
      assert.ok(!source.includes(forbidden), `${relative} must not call ${forbidden}`);
    }
  }
});
