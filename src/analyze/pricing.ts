/**
 * Model pricing — ported verbatim from cc-haha `src/utils/modelCost.ts`
 * (rates) and `src/utils/usageAccounting.ts` (model → tier mapping).
 *
 * Two deliberate cc-haha behaviours are preserved:
 *
 *  1. An unknown model returns `null`, never a zero and never a fallback tier.
 *     cc-haha's `estimateCostUSD()` refuses to price a model it has no published
 *     rates for, because cc-haha is a multi-provider client and pricing a
 *     third-party model (glm, deepseek, grok, kimi, ...) at Claude rates reports
 *     wildly wrong dollars. Callers must treat `null` as "exclude from the cost
 *     total", not as "free".
 *  2. Longest matching prefix wins, so a bare family name can sit next to its
 *     versioned variants without shadowing them.
 *
 * Rates are USD per million tokens.
 */

import type { TokenCounts } from '../types.js';

export interface ModelRates {
  inputTokens: number;
  outputTokens: number;
  promptCacheWriteTokens: number;
  promptCacheReadTokens: number;
}

// Pricing tier for Sonnet 4.x and earlier: $3 input / $15 output per Mtok
const COST_TIER_3_15: ModelRates = { inputTokens: 3, outputTokens: 15, promptCacheWriteTokens: 3.75, promptCacheReadTokens: 0.3 };
// Sonnet 5 and 5.5: $2 input / $10 output per Mtok (introductory price made standard)
const COST_TIER_2_10: ModelRates = { inputTokens: 2, outputTokens: 10, promptCacheWriteTokens: 2.5, promptCacheReadTokens: 0.2 };
// Opus 4 / 4.1: $15 input / $75 output per Mtok
const COST_TIER_15_75: ModelRates = { inputTokens: 15, outputTokens: 75, promptCacheWriteTokens: 18.75, promptCacheReadTokens: 1.5 };
// Opus 4.5 / 4.6 / 4.8 / 5: $5 input / $25 output per Mtok
const COST_TIER_5_25: ModelRates = { inputTokens: 5, outputTokens: 25, promptCacheWriteTokens: 6.25, promptCacheReadTokens: 0.5 };
// Fable 5 / Mythos 5: $10 input / $50 output per Mtok
const COST_TIER_10_50: ModelRates = { inputTokens: 10, outputTokens: 50, promptCacheWriteTokens: 12.5, promptCacheReadTokens: 1 };
// Fable 5.1 keeps Fable 5 input/output pricing but reduces cache reads by 75%
const COST_FABLE_51: ModelRates = { ...COST_TIER_10_50, promptCacheReadTokens: 0.25 };
// Opus 5.5 standard pricing from the official Claude Code model catalog
const COST_OPUS_55: ModelRates = { inputTokens: 4, outputTokens: 20, promptCacheWriteTokens: 5, promptCacheReadTokens: 0.2 };
// Opus 5.5 fast mode (research preview)
const COST_OPUS_55_FAST: ModelRates = { inputTokens: 8, outputTokens: 40, promptCacheWriteTokens: 10, promptCacheReadTokens: 0.4 };
// Fast-mode pricing for Opus 4.7
const COST_TIER_30_150: ModelRates = { inputTokens: 30, outputTokens: 150, promptCacheWriteTokens: 37.5, promptCacheReadTokens: 3 };
// Haiku 3.5: $0.80 input / $4 output per Mtok
const COST_HAIKU_35: ModelRates = { inputTokens: 0.8, outputTokens: 4, promptCacheWriteTokens: 1, promptCacheReadTokens: 0.08 };
// Haiku 4.5: $1 input / $5 output per Mtok
const COST_HAIKU_45: ModelRates = { inputTokens: 1, outputTokens: 5, promptCacheWriteTokens: 1.25, promptCacheReadTokens: 0.1 };

/** Longest match wins, so a bare family name may sit next to its versioned variants. */
const MODEL_TIERS: ReadonlyArray<readonly [string, ModelRates]> = [
  ['claude-opus-5-5', COST_OPUS_55],
  ['claude-opus-5', COST_TIER_5_25],
  ['claude-opus-4-8', COST_TIER_5_25],
  ['claude-opus-4-7', COST_TIER_5_25],
  ['claude-opus-4-6', COST_TIER_5_25],
  ['claude-opus-4-5', COST_TIER_5_25],
  ['claude-opus-4-1', COST_TIER_15_75],
  ['claude-opus-4', COST_TIER_15_75],
  ['claude-fable-5', COST_TIER_10_50],
  ['claude-fable-5-1', COST_FABLE_51],
  ['claude-mythos-5', COST_TIER_10_50],
  ['claude-sonnet-5-5', COST_TIER_2_10],
  ['claude-sonnet-5', COST_TIER_2_10],
  ['claude-sonnet-4-6', COST_TIER_3_15],
  ['claude-sonnet-4-5', COST_TIER_3_15],
  ['claude-sonnet-4', COST_TIER_3_15],
  ['claude-3-7-sonnet', COST_TIER_3_15],
  ['claude-3-5-sonnet', COST_TIER_3_15],
  ['claude-haiku-4-5', COST_HAIKU_45],
  ['claude-3-5-haiku', COST_HAIKU_35],
  ['claude-3-haiku', COST_HAIKU_35],
  ['claude-3-opus', COST_TIER_15_75],
];

const FAST_MODE_TIERS: ReadonlyArray<readonly [string, ModelRates]> = [
  ['claude-opus-5-5', COST_OPUS_55_FAST],
  ['claude-opus-5', COST_TIER_10_50],
  ['claude-opus-4-8', COST_TIER_10_50],
  ['claude-opus-4-7', COST_TIER_30_150],
];

/** `claude-opus-4-8-20260101`, `claude-opus-4-8-r`, `anthropic/claude-sonnet-5`. */
export function normalizeModelId(model: string): string {
  const trimmed = model.trim().toLowerCase();
  if (!trimmed) return '';
  const withoutVendor = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return withoutVendor.replace(/-\d{8}$/, '').replace(/-(r|thinking|latest)$/, '');
}

function matchTier(normalized: string, tiers: ReadonlyArray<readonly [string, ModelRates]>): ModelRates | null {
  let best: ModelRates | null = null;
  let bestLength = 0;
  for (const [prefix, rates] of tiers) {
    if (prefix.length <= bestLength) continue;
    if (normalized === prefix || normalized.startsWith(`${prefix}-`)) {
      best = rates;
      bestLength = prefix.length;
    }
  }
  return best;
}

/**
 * Rates for a model, or `null` when we have no published pricing for it (every
 * third-party provider, and any Claude model released after this table was last
 * updated).
 */
export function resolveModelRates(model: string, speed?: string): ModelRates | null {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;
  if (speed === 'fast') {
    const fast = matchTier(normalized, FAST_MODE_TIERS);
    if (fast) return fast;
  }
  return matchTier(normalized, MODEL_TIERS);
}

export interface CostInput extends TokenCounts {
  speed?: string;
}

/**
 * Dollars actually billed for one turn, or `null` when the model can't be priced.
 * Same shape as cc-haha's `estimateCostUSD()`.
 */
export function actualCostUSD(model: string, tokens: CostInput): number | null {
  const rates = resolveModelRates(model, tokens.speed);
  if (!rates) return null;
  return (
    (tokens.input / 1_000_000) * rates.inputTokens +
    (tokens.output / 1_000_000) * rates.outputTokens +
    (tokens.cacheRead / 1_000_000) * rates.promptCacheReadTokens +
    (tokens.cacheCreation / 1_000_000) * rates.promptCacheWriteTokens
  );
}

/**
 * What the same prompt would have cost with caching switched off: every prompt
 * token billed at the full input rate, plus the same output.
 */
export function noCacheCostUSD(model: string, tokens: CostInput): number | null {
  const rates = resolveModelRates(model, tokens.speed);
  if (!rates) return null;
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheCreation;
  return (prompt / 1_000_000) * rates.inputTokens + (tokens.output / 1_000_000) * rates.outputTokens;
}

/** Dollars a cache WRITE would have cost had those tokens been read instead. */
export function writePremiumUSD(model: string, cacheCreation: number, speed?: string): number | null {
  const rates = resolveModelRates(model, speed);
  if (!rates) return null;
  return (cacheCreation / 1_000_000) * (rates.promptCacheWriteTokens - rates.promptCacheReadTokens);
}

/** `$0.0123` / `<$0.0001` / `--` for an unpriceable model. */
export function formatUSD(value: number | null, digits = 4): string {
  if (value === null || !Number.isFinite(value)) return '--';
  if (value === 0) return '$0';
  if (Math.abs(value) < 0.0001) return value > 0 ? '<$0.0001' : '>-$0.0001';
  if (Math.abs(value) >= 100) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(digits)}`;
}
