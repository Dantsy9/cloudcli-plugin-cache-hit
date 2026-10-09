/**
 * Usage normalisation — the accounting 口径 ported from cc-haha.
 *
 * Sources of truth in cc-haha:
 *   - `src/utils/usageAccounting.ts`          (dedupe key, fork inheritance, validity)
 *   - `src/server/proxy/transform/usage.ts`   (direct vs nested cache semantics)
 *   - `src/server/services/localIndex/transcriptReducer.ts` + `src/utils/stats.ts`
 *                                             (5m/1h split preferred over the aggregate)
 *
 * The single rule everything else depends on: the four buckets are DISJOINT.
 * `input_tokens` never contains cached tokens, so `input + cacheRead +
 * cacheCreation` is the whole prompt for one request, and that sum is the only
 * honest denominator for a cache hit rate.
 */

import type { TokenCounts } from '../types.js';

/** A finite, non-negative number, else 0. Mirrors `safeUsageTokenCount` in cc-haha. */
export function tokenNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** True when the value is a usable number at all (used to detect "field absent"). */
function hasNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First present numeric field among the given keys. Providers spell these differently. */
function pickNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    if (hasNumber(source[key])) return source[key] as number;
  }
  return undefined;
}

const CACHE_READ_KEYS = [
  'cache_read_input_tokens',
  'cacheReadInputTokens',
  'cacheReadTokens',
  'cached_tokens',
];

const CACHE_WRITE_KEYS = [
  'cache_creation_input_tokens',
  'cacheCreationInputTokens',
  'cacheWriteInputTokens',
  'cacheWriteTokens',
];

const INPUT_KEYS = ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokenCount'];
const OUTPUT_KEYS = ['output_tokens', 'outputTokens', 'completion_tokens', 'candidatesTokenCount'];

/**
 * Cache-write tokens, preferring the 5m/1h split over the aggregate field.
 *
 * cc-haha reads it this way in both stats paths (`transcriptReducer.ts:364`,
 * `stats.ts:149`): when `cache_creation` is present the aggregate
 * `cache_creation_input_tokens` may be absent or zero, so trusting it first
 * silently drops every write.
 */
export function readCacheCreation(usage: Record<string, unknown>): number {
  const split = usage.cache_creation;
  if (isRecord(split)) {
    const splitTotal =
      tokenNumber(split.ephemeral_5m_input_tokens) + tokenNumber(split.ephemeral_1h_input_tokens);
    if (splitTotal > 0) return splitTotal;
  }
  return pickNumber(usage, CACHE_WRITE_KEYS) ?? 0;
}

export interface NormalizedUsage extends TokenCounts {
  /** True when the source used an OpenAI-compatible shape we had to translate. */
  translated: boolean;
  /** 5m / 1h split when the provider reported it. */
  cacheCreation5m: number;
  cacheCreation1h: number;
}

/**
 * Translate one provider `usage` object into the disjoint-bucket model.
 *
 * Direct Anthropic-style `cache_*` fields are EXCLUSIVE of `input_tokens`.
 * Nested OpenAI-style `input_tokens_details.cached_tokens` /
 * `prompt_tokens_details.cached_tokens` are INCLUSIVE and must be subtracted, or
 * the prompt total double-counts every cache hit. Ported from
 * `openaiUsageToAnthropic()` in cc-haha's proxy transform, including its
 * precedence rule: any positive direct cache field wins, so a gateway that
 * writes `cache_read_input_tokens: 0` next to a real nested count cannot
 * suppress the hit accounting.
 */
export function normalizeUsage(usage: Record<string, unknown>): NormalizedUsage {
  const directRead = pickNumber(usage, ['cache_read_input_tokens', 'cacheReadInputTokens', 'cacheReadTokens']);
  const directWrite = pickNumber(usage, ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cacheWriteInputTokens']);
  const hasDirectCache = (directRead ?? 0) > 0 || (directWrite ?? 0) > 0;

  let nestedRead = 0;
  for (const key of ['input_tokens_details', 'prompt_tokens_details']) {
    const details = usage[key];
    if (isRecord(details) && hasNumber(details.cached_tokens)) {
      nestedRead = details.cached_tokens as number;
      break;
    }
  }

  let input = pickNumber(usage, INPUT_KEYS) ?? 0;
  const output = pickNumber(usage, OUTPUT_KEYS) ?? 0;

  let cacheRead: number;
  if (hasDirectCache) {
    cacheRead = directRead ?? 0;
  } else {
    // Inclusive semantics: cap a malformed count at the reported input so the
    // total cannot go negative.
    cacheRead = Math.min(nestedRead, input);
    input = Math.max(0, input - cacheRead);
  }

  const split = usage.cache_creation;
  const cacheCreation5m = isRecord(split) ? tokenNumber(split.ephemeral_5m_input_tokens) : 0;
  const cacheCreation1h = isRecord(split) ? tokenNumber(split.ephemeral_1h_input_tokens) : 0;

  return {
    input,
    output,
    cacheRead,
    cacheCreation: readCacheCreation(usage),
    translated: !hasDirectCache && nestedRead > 0,
    cacheCreation5m,
    cacheCreation1h,
  };
}

/** `input + cacheRead + cacheCreation` — one request's whole prompt. */
export function promptTokens(counts: TokenCounts): number {
  return counts.input + counts.cacheRead + counts.cacheCreation;
}

/* ── Record validity & deduplication (cc-haha `usageAccounting.ts`) ───────── */

export interface UsageIdentity {
  version?: unknown;
  sessionId?: unknown;
  requestId?: unknown;
  messageId?: unknown;
  forkedFrom?: unknown;
}

/**
 * Conversation branches copy the selected prefix into a new transcript so the
 * fork keeps its context. Those lines keep their original `usage` and carry this
 * provenance marker; the API calls belong to the source session and must not be
 * attributed to the fork a second time.
 */
export function isForkInheritedRecord(record: { forkedFrom?: unknown }): boolean {
  const forkedFrom = record.forkedFrom;
  if (!isRecord(forkedFrom)) return false;
  return (
    typeof forkedFrom.sessionId === 'string' &&
    forkedFrom.sessionId.length > 0 &&
    typeof forkedFrom.messageUuid === 'string' &&
    forkedFrom.messageUuid.length > 0
  );
}

/**
 * Deduplication key for one usage record, or null when the line carries no
 * message id to key on (those are always counted, matching ccusage).
 *
 * Claude Code writes one JSONL line per content block of an assistant message —
 * a reply with thinking, text and a dozen tool_use blocks is fourteen lines —
 * and every one repeats the same complete `usage` object. Counting each line
 * once per block inflated real transcripts by 2.2x.
 */
export function usageRecordKey(identity: UsageIdentity, suffix = ''): string | null {
  const messageId = identity.messageId;
  if (typeof messageId !== 'string' || !messageId) return null;
  const requestId = typeof identity.requestId === 'string' ? identity.requestId : '';
  return `${messageId}\u0000${requestId}${suffix}`;
}
