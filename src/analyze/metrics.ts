/**
 * Hit-rate metrics and formatting.
 *
 * The formula is the one cc-haha uses in five separate places, always with the
 * same denominator:
 *
 *     hitRate = cacheRead / (input + cacheRead + cacheCreation)
 *
 *   - `desktop/src/lib/sessionUsageMetrics.ts:58`
 *   - `src/utils/forkedAgent.ts:662`
 *   - `src/services/compact/compact.ts:1216`
 *   - `src/utils/telemetry/perfettoTracing.ts:517`
 *   - `desktop/src/components/trajectory/TrajectoryToolbar.tsx:67`
 *
 * The formatter is also cc-haha's: a session at 99.96% is NOT fully cached, and
 * printing "100%" would tell the user something false about both their bill and
 * their prompt stability.
 */

import type { CostBreakdown, ModelBreakdown, SessionTotals, TokenCounts, TurnMetrics } from '../types.js';
import { actualCostUSD, noCacheCostUSD, resolveModelRates, writePremiumUSD } from './pricing.js';

export function newCounts(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

export function addCounts(target: TokenCounts, source: TokenCounts): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheCreation += source.cacheCreation;
}

export function emptyCost(): CostBreakdown {
  return { actualUSD: 0, noCacheUSD: 0, savedUSD: 0, wastedWriteUSD: 0 };
}

/** A cost bucket is only "unknown" when no priced turn contributed to it. */
export function accumulateCost(target: CostBreakdown, add: CostBreakdown): void {
  accumulateCostField(target, add, 'actualUSD');
  accumulateCostField(target, add, 'noCacheUSD');
  accumulateCostField(target, add, 'savedUSD');
  accumulateCostField(target, add, 'wastedWriteUSD');
}

function accumulateCostField(target: CostBreakdown, add: CostBreakdown, key: keyof CostBreakdown): void {
  const a = target[key];
  const b = add[key];
  if (b === null) return; // unpriced contribution — do not invent a number
  target[key] = (a ?? 0) + b;
}

export function finalizeCosts(cost: CostBreakdown, pricedTurns: number): CostBreakdown {
  if (pricedTurns === 0) {
    return { actualUSD: null, noCacheUSD: null, savedUSD: null, wastedWriteUSD: null };
  }
  return cost;
}

/**
 * Cost impact of one turn's token mix, including the counterfactual with caching
 * disabled. `null` on every field when the model is unpriceable.
 */
export function turnCost(model: string, tokens: TokenCounts, speed?: string): CostBreakdown {
  const actual = actualCostUSD(model, { ...tokens, speed });
  const noCache = noCacheCostUSD(model, { ...tokens, speed });
  if (actual === null || noCache === null) {
    return { actualUSD: null, noCacheUSD: null, savedUSD: null, wastedWriteUSD: null };
  }
  // A write is "wasted" when those same tokens would have been cheaper to read.
  // It is a premium, not a total loss — the entry may still be read next turn.
  const wasted = writePremiumUSD(model, tokens.cacheCreation, speed);
  return {
    actualUSD: actual,
    noCacheUSD: noCache,
    savedUSD: noCache - actual,
    wastedWriteUSD: wasted === null || wasted < 0 ? 0 : wasted,
  };
}

export function hitRateOf(counts: TokenCounts): number | null {
  const prompt = counts.input + counts.cacheRead + counts.cacheCreation;
  return prompt > 0 ? counts.cacheRead / prompt : null;
}

export function summarizeTotals(turns: TurnMetrics[]): SessionTotals {
  const counts = newCounts();
  const cost = emptyCost();
  let priced = 0;
  let rateSum = 0;
  let rateCount = 0;

  for (const turn of turns) {
    addCounts(counts, turn);
    accumulateCost(cost, turn.cost);
    if (turn.cost.actualUSD !== null) priced += 1;
    if (turn.hitRate !== null) {
      rateSum += turn.hitRate;
      rateCount += 1;
    }
  }

  const prompt = counts.input + counts.cacheRead + counts.cacheCreation;
  return {
    ...counts,
    promptTokens: prompt,
    // Cache reads are replayed every turn of an agent loop; counting them as spend
    // made a 270k-window session look like 40M "total tokens" in cc-haha.
    newTokens: counts.input + counts.output,
    hitRate: prompt > 0 ? counts.cacheRead / prompt : null,
    meanTurnHitRate: rateCount > 0 ? rateSum / rateCount : null,
    turns: turns.length,
    cost: finalizeCosts(cost, priced),
  };
}

export function summarizeModels(turns: TurnMetrics[]): ModelBreakdown[] {
  const byModel = new Map<string, TurnMetrics[]>();
  for (const turn of turns) {
    const list = byModel.get(turn.model);
    if (list) list.push(turn);
    else byModel.set(turn.model, [turn]);
  }

  const out: ModelBreakdown[] = [];
  for (const [model, list] of byModel) {
    const totals = summarizeTotals(list);
    out.push({
      model,
      turns: totals.turns,
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheCreation: totals.cacheCreation,
      promptTokens: totals.promptTokens,
      newTokens: totals.newTokens,
      hitRate: totals.hitRate,
      cost: totals.cost,
      priced: resolveModelRates(model) !== null,
    });
  }
  out.sort((a, b) => b.promptTokens - a.promptTokens);
  return out;
}

/* ── Formatting (ported from cc-haha `sessionUsageMetrics.ts`) ────────────── */

/**
 * Formats a cache hit rate without ever rounding a partial hit up to a flat 100%.
 *
 * A session at 99.96% is *not* fully cached, and printing "100%" would tell the
 * user something false about both their bill and their prompt stability.
 * Widening the precision is the honest fix; only a rate that is exactly 1
 * renders as 100%.
 */
export function formatCacheHitRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return '0%';
  if (rate >= 1) return '100%';
  const percent = rate * 100;
  const oneDecimal = percent.toFixed(1);
  if (oneDecimal !== '100.0') return `${oneDecimal}%`;
  const twoDecimals = percent.toFixed(2);
  if (twoDecimals === '100.00') return '99.99%';
  return `${twoDecimals}%`;
}

/** `1.2M`, `375K`, `812` — compact enough for a stat row, never a lie about magnitude. */
export function formatCompactTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return '0';
  if (value < 1_000) return `${Math.round(value)}`;
  const thousands = value / 1_000;
  const decimals = thousands >= 100 ? 0 : 1;
  if (Number(thousands.toFixed(decimals)) >= 1_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  return `${thousands.toFixed(decimals)}K`;
}

export function formatFullTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--';
  return Math.round(value).toLocaleString('en-US');
}

/** `just now` / `12m ago` / `3h ago` / `2d ago`. */
export function formatAgo(ms: number, now = Date.now()): string {
  const seconds = Math.floor((now - ms) / 1000);
  if (seconds < 0) return 'in the future';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** `4.2s` / `3m 10s` / `1h 04m` — gap between two turns. */
export function formatGap(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '--';
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
}

export function formatClock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '--';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDateTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '--';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
