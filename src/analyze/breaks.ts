/**
 * Cache-break detection and attribution.
 *
 * Ported from cc-haha `src/services/api/promptCacheBreakDetection.ts`, adapted to
 * a *post-hoc transcript* data source. cc-haha runs two phases around a live API
 * call: `recordPromptState()` hashes the outgoing prompt before the call, and
 * `checkResponseForCacheBreak()` compares the returned cache tokens against the
 * previous call, then explains the drop using the recorded diff.
 *
 * A plugin cannot see the outgoing request, so the diff half is unavailable and
 * attribution is narrowed to what a transcript genuinely proves. Everything
 * below is either a measurement or a labelled inference — never a guess dressed
 * up as a measurement.
 *
 * Rules carried over verbatim:
 *   - MIN_CACHE_MISS_TOKENS  = 2000            (small drops are noise)
 *   - drop ratio rule                          cacheRead < prev * 0.95
 *   - CACHE_TTL_5MIN_MS / CACHE_TTL_1HOUR_MS   server-side cache lifetimes
 *   - haiku models are excluded                different caching behaviour
 *   - compaction resets the baseline instead of alerting
 */

import type { BreakCause, CacheBreak, TurnMetrics } from '../types.js';
import { resolveModelRates } from './pricing.js';

/** Minimum absolute token drop required to call it a break. */
export const MIN_CACHE_MISS_TOKENS = 2000;

/** Anthropic's server-side prompt cache TTL thresholds. */
export const CACHE_TTL_5MIN_MS = 5 * 60 * 1000;
export const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000;

/**
 * A prompt that moved by less than this fraction counts as "unchanged" for
 * attribution purposes. cc-haha compares hashes so it needs no threshold; a
 * transcript only carries token counts, so we need one. 2% is deliberately
 * generous — it must not swallow a real prefix edit.
 */
const PROMPT_UNCHANGED_RATIO = 0.02;
const PROMPT_UNCHANGED_FLOOR = 500;

/** haiku has different caching behaviour; cc-haha excludes it from break detection. */
export function isExcludedModel(model: string): boolean {
  return model.includes('haiku');
}

export interface BreakDetectionTurn extends TurnMetrics {
  /**
   * True when a compaction boundary was seen after the previous counted turn and
   * at or before this one. Compaction removes messages on purpose, so the cache
   * read is expected to fall — cc-haha calls that out as "not a break".
   */
  afterCompaction: boolean;
}

export function detectBreaks(turns: BreakDetectionTurn[]): { breaks: CacheBreak[]; warnings: string[] } {
  const breaks: CacheBreak[] = [];
  const warnings: string[] = [];
  let excludedModelBreaks = 0;
  let postCompactionDrops = 0;

  for (let i = 1; i < turns.length; i += 1) {
    const previous = turns[i - 1]!;
    const current = turns[i]!;

    // Nothing to lose: the previous turn was itself uncached (session start, or
    // the first turn after a baseline reset).
    if (previous.cacheRead <= 0) continue;

    const lost = previous.cacheRead - current.cacheRead;
    const isDrop = current.cacheRead < previous.cacheRead * 0.95 && lost >= MIN_CACHE_MISS_TOKENS;
    if (!isDrop) continue;

    // Compaction legitimately reduces the cached prefix — expected, not a break.
    if (current.afterCompaction) {
      postCompactionDrops += 1;
      continue;
    }

    // cc-haha skips haiku wholesale ("different caching behavior"); the ratio
    // rule produces false positives there.
    if (isExcludedModel(current.model) || isExcludedModel(previous.model)) {
      excludedModelBreaks += 1;
      continue;
    }

    const gapMs = gapBetween(previous, current);
    const promptDelta = current.promptTokens - previous.promptTokens;
    const unchangedThreshold = Math.max(PROMPT_UNCHANGED_FLOOR, previous.promptTokens * PROMPT_UNCHANGED_RATIO);

    const verdict = attribute({
      gapMs,
      modelChanged: current.model !== previous.model,
      previousModel: previous.model,
      model: current.model,
      promptUnchanged: Math.abs(promptDelta) <= unchangedThreshold,
      promptDelta,
      previousPromptTokens: previous.promptTokens,
      promptTokens: current.promptTokens,
      cacheRead: current.cacheRead,
      previousCacheRead: previous.cacheRead,
    });

    breaks.push({
      turnIndex: current.index,
      line: current.line,
      timestamp: current.timestamp,
      model: current.model,
      previousModel: previous.model,
      previousCacheRead: previous.cacheRead,
      cacheRead: current.cacheRead,
      lostCachedTokens: lost,
      prefixMatchRatio: previous.cacheRead > 0 ? current.cacheRead / previous.cacheRead : 0,
      prefixMatchedTokens: current.cacheRead,
      previousPromptTokens: previous.promptTokens,
      promptTokens: current.promptTokens,
      promptDelta,
      gapMs,
      cause: verdict.cause,
      detail: verdict.detail,
      extraCostUSD: lostCost(current.model, lost),
    });
  }

  if (excludedModelBreaks > 0) {
    warnings.push(
      `已按 cc-haha 口径跳过 ${excludedModelBreaks} 处发生在 haiku 模型上的命中率下降（该系列缓存行为不同，判定会产生假阳性）。`,
    );
  }
  if (postCompactionDrops > 0) {
    warnings.push(`已跳过 ${postCompactionDrops} 处压缩（compact）后的缓存下降——压缩主动削减消息，这是预期行为而非断裂。`);
  }
  if (breaks.length > 0) {
    warnings.push(
      '断裂归因基于 transcript 的间接证据（token 计数 + 时间差 + 模型名），而非 cc-haha 请求前的 prompt 哈希对比；"前缀变化"与"疑似服务端"的区分是启发式判断。',
    );
  }

  return { breaks, warnings };
}

interface AttributionInput {
  gapMs: number | null;
  modelChanged: boolean;
  previousModel: string;
  model: string;
  promptUnchanged: boolean;
  promptDelta: number;
  previousPromptTokens: number;
  promptTokens: number;
  cacheRead: number;
  previousCacheRead: number;
}

function attribute(input: AttributionInput): { cause: BreakCause; detail: string } {
  // `cacheRead` is the length of the prefix the server served from cache, so the
  // first token that did NOT match sits right after it. That is a real
  // measurement, not a guess — it localises where the prefix diverged.
  const prefixNote =
    input.cacheRead === 0
      ? '缓存前缀完全没有命中（0 tokens）'
      : `匹配到的缓存前缀约 ${input.cacheRead.toLocaleString('en-US')} tokens，即约在上一轮的 ${((input.cacheRead / input.previousCacheRead) * 100).toFixed(1)}% 处断开`;

  if (input.modelChanged) {
    return {
      cause: 'model_changed',
      detail: `模型由 ${input.previousModel} 切换为 ${input.model}。服务端缓存按模型隔离，切换后必然全量重写。`,
    };
  }

  if (input.gapMs !== null && input.gapMs > CACHE_TTL_1HOUR_MS) {
    return {
      cause: 'ttl_1h',
      detail: `距上一轮 ${(input.gapMs / 60000).toFixed(1)} 分钟，超过 1 小时 TTL。即便 prompt 完全未变也会过期。${prefixNote}。`,
    };
  }

  if (input.gapMs !== null && input.gapMs > CACHE_TTL_5MIN_MS) {
    return {
      cause: 'ttl_5m',
      detail: `距上一轮 ${(input.gapMs / 60000).toFixed(1)} 分钟，超过 5 分钟 TTL（默认 cache_control 为 ephemeral 5m）。${prefixNote}。`,
    };
  }

  if (!input.promptUnchanged) {
    return {
      cause: 'prefix_changed',
      detail: `prompt 较上一轮变化 ${formatDelta(input.promptDelta)}（${input.previousPromptTokens.toLocaleString('en-US')} → ${input.promptTokens.toLocaleString('en-US')} tokens）。前缀内容一旦改动，改动点之后全部失效：${prefixNote}。常见来源是 system prompt、工具 schema（含 MCP 工具列表）或更早的历史消息被重写。`,
    };
  }

  if (input.gapMs !== null) {
    return {
      cause: 'server_side',
      detail: `prompt 几乎未变（${formatDelta(input.promptDelta)}），间隔仅 ${(input.gapMs / 1000).toFixed(1)} 秒，未触及 TTL。cc-haha 对此类情形的结论是"大概率服务端路由/驱逐，或计费与推理不一致"：${prefixNote}。`,
    };
  }

  return {
    cause: 'unknown',
    detail: `transcript 缺少可用时间戳，无法用 TTL 解释；prompt 变化 ${formatDelta(input.promptDelta)}。${prefixNote}。`,
  };
}

function formatDelta(delta: number): string {
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toLocaleString('en-US')} tokens`;
}

function gapBetween(previous: TurnMetrics, current: TurnMetrics): number | null {
  if (previous.timestamp === null || current.timestamp === null) return null;
  const gap = current.timestamp - previous.timestamp;
  return gap >= 0 ? gap : null;
}

/**
 * What the lost cached prefix cost at full input price instead of the cache-read
 * price. Null when the model is unpriceable.
 */
function lostCost(model: string, lostTokens: number): number | null {
  const rates = resolveModelRates(model);
  if (!rates) return null;
  return (lostTokens / 1_000_000) * (rates.inputTokens - rates.promptCacheReadTokens);
}

/** Chinese label for each cause, used by the UI. */
export function breakCauseLabel(cause: BreakCause): string {
  switch (cause) {
    case 'cold_start':
      return '冷启动';
    case 'compaction':
      return '压缩后重建';
    case 'model_changed':
      return '模型切换';
    case 'ttl_1h':
      return '1h TTL 过期';
    case 'ttl_5m':
      return '5m TTL 过期';
    case 'prefix_changed':
      return '前缀变化';
    case 'server_side':
      return '疑似服务端';
    default:
      return '未确定';
  }
}
