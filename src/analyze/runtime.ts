/**
 * Runtime telemetry read back out of the transcript.
 *
 * Claude Code checkpoints its session cost state into the transcript as
 * `{ type: 'cost-state', ... }` records — the same shape cc-haha persists via
 * `saveCurrentSessionCosts()` in `src/cost-tracker.ts`. One real transcript
 * contained nine of them, monotonically growing from 20% through to EOF.
 *
 * This is the ONLY place a transcript exposes an API-duration figure, and that
 * figure is what an honest output rate needs. cc-haha's `deriveSessionUsageMetrics`
 * divides output tokens by API wall-clock and deliberately refuses a rate computed
 * against session wall-clock:
 *
 *   "`tokensPerSecond` divides output tokens by the time the API was actually
 *    running, including prefill. A caller that only has a transcript (no API
 *    duration) gets `null` rather than a rate computed against wall clock that
 *    includes `Bash`."
 *   — desktop/src/lib/sessionUsageMetrics.ts
 *
 * Two things this state is good for, and one it is not:
 *   - GOOD: output tokens per second, with prefill included and tool execution
 *     excluded (`totalToolDuration` is tracked separately).
 *   - GOOD: an independent, runtime-computed cross-check of the session's cache
 *     hit rate, because `modelUsage` carries the cumulative cache buckets the
 *     runtime itself accumulated.
 *   - NOT: per-turn granularity, so cache-break detection still comes from the
 *     per-turn extraction in `summarize.ts`.
 */

import type { RuntimeModelUsage, RuntimeState } from '../types.js';
import type { ParsedLine } from './transcript.js';
import { isRecord, tokenNumber } from './usage.js';

export const EMPTY_RUNTIME_STATE: RuntimeState = {
  present: false,
  snapshots: 0,
  startTime: null,
  totalAPIDurationMs: 0,
  totalAPIDurationWithoutRetriesMs: 0,
  totalToolDurationMs: 0,
  totalDurationMs: 0,
  totalCostUSD: 0,
  totalOutputTokens: 0,
  promptTokens: 0,
  cacheRead: 0,
  cacheCreation: 0,
  hitRate: null,
  models: [],
};

export function isCostStateRecord(record: Record<string, unknown>): boolean {
  return record.type === 'cost-state';
}

function readModelUsage(raw: unknown): RuntimeModelUsage[] {
  if (!isRecord(raw)) return [];
  const out: RuntimeModelUsage[] = [];
  for (const [model, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    out.push({
      model,
      input: tokenNumber(value.inputTokens),
      output: tokenNumber(value.outputTokens),
      cacheRead: tokenNumber(value.cacheReadInputTokens),
      cacheCreation: tokenNumber(value.cacheCreationInputTokens),
      costUSD: typeof value.costUSD === 'number' && Number.isFinite(value.costUSD) ? value.costUSD : 0,
    });
  }
  out.sort((a, b) => b.input + b.cacheRead + b.cacheCreation - (a.input + a.cacheRead + a.cacheCreation));
  return out;
}

/**
 * Read the newest `cost-state` snapshot out of already-parsed transcript lines.
 *
 * The LAST record in file order wins, not the largest: the snapshots are
 * cumulative checkpoints, so the final one is the session's current state. When
 * only the tail of an oversized transcript was read, the last snapshot inside
 * that window is still the newest available — which is the correct answer, just
 * measured over a shorter history.
 */
export function readRuntimeState(lines: ParsedLine[]): RuntimeState {
  let latest: Record<string, unknown> | null = null;
  let snapshots = 0;

  for (const { record } of lines) {
    if (!isCostStateRecord(record)) continue;
    snapshots += 1;
    latest = record;
  }

  if (!latest) return { ...EMPTY_RUNTIME_STATE };

  const models = readModelUsage(latest.modelUsage);
  const cacheRead = models.reduce((sum, m) => sum + m.cacheRead, 0);
  const cacheCreation = models.reduce((sum, m) => sum + m.cacheCreation, 0);
  const input = models.reduce((sum, m) => sum + m.input, 0);
  const output = models.reduce((sum, m) => sum + m.output, 0);
  const promptTokens = input + cacheRead + cacheCreation;
  const startTime = typeof latest.startTime === 'number' && Number.isFinite(latest.startTime) ? latest.startTime : null;

  return {
    present: true,
    snapshots,
    startTime,
    totalAPIDurationMs: tokenNumber(latest.totalAPIDuration),
    totalAPIDurationWithoutRetriesMs: tokenNumber(latest.totalAPIDurationWithoutRetries),
    totalToolDurationMs: tokenNumber(latest.totalToolDuration),
    totalDurationMs: tokenNumber(latest.totalDuration),
    totalCostUSD: typeof latest.totalCostUSD === 'number' && Number.isFinite(latest.totalCostUSD) ? latest.totalCostUSD : 0,
    totalOutputTokens: output,
    promptTokens,
    cacheRead,
    cacheCreation,
    // The runtime's own cumulative view — includes every model it billed,
    // subagents included, so it can legitimately differ from the main-thread
    // figure the rest of the panel reports.
    hitRate: promptTokens > 0 ? cacheRead / promptTokens : null,
    models,
  };
}
