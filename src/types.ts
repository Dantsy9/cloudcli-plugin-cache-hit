/**
 * Shared type definitions for the CloudCLI `cache-hit` plugin.
 *
 * Two consumers:
 *   - `src/server.ts` (Node subprocess) — produces these shapes
 *   - `src/index.ts`  (browser module)   — consumes them
 *
 * `index.ts` must import from this file with `import type` ONLY. The host loads
 * the frontend module from a Blob URL, so any *runtime* relative import would
 * resolve against `blob:` and fail. Type-only imports are erased by tsc.
 */

/* ── CloudCLI host plugin API (mirrors the official starter's types.ts) ───── */

export interface PluginContext {
  theme: 'dark' | 'light';
  /** `name` is the host's opaque DB project id, NOT the folder name. */
  project: { name: string; path: string } | null;
  /** `id` is the host's app session id, NOT the Claude Code transcript id. */
  session: { id: string; title: string } | null;
}

export interface PluginAPI {
  readonly context: PluginContext;
  onContextChange(callback: (ctx: PluginContext) => void): () => void;
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
}

export interface PluginModule {
  mount(container: HTMLElement, api: PluginAPI): void | Promise<void>;
  unmount?(container: HTMLElement): void;
}

/* ── Token accounting ────────────────────────────────────────────────────── */

/**
 * The three prompt-side buckets are DISJOINT: `input` never includes cached
 * tokens, so `input + cacheRead + cacheCreation` is exactly the prompt total for
 * one request. Same rule as `desktop/src/lib/sessionUsageMetrics.ts` in cc-haha.
 */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface CostBreakdown {
  /** Dollars actually billed for these tokens, or null when the model is unpriceable. */
  actualUSD: number | null;
  /** What the same turns would have cost with no prompt caching at all. */
  noCacheUSD: number | null;
  /** `noCacheUSD - actualUSD`. Negative means cache writes cost more than they saved. */
  savedUSD: number | null;
  /** Write-rate premium over the cache-read rate: what the writes cost beyond a read. */
  wastedWriteUSD: number | null;
}

export interface TurnMetrics extends TokenCounts {
  /** 0-based index among counted (deduped, main-thread, usage-bearing) turns. */
  index: number;
  /** Source JSONL line number, for cross-referencing the raw transcript. */
  line: number;
  timestamp: number | null;
  model: string;
  /** `input + cacheRead + cacheCreation` — this one request's whole prompt. */
  promptTokens: number;
  /** New tokens only (`input + output`). Cache reads are not new spend. */
  newTokens: number;
  /** `cacheRead / promptTokens`, or null when the prompt was empty. */
  hitRate: number | null;
  cost: CostBreakdown;
}

export type BreakCause =
  | 'cold_start'
  | 'compaction'
  | 'model_changed'
  | 'ttl_1h'
  | 'ttl_5m'
  | 'prefix_changed'
  | 'server_side'
  | 'unknown';

export interface CacheBreak {
  /** Index into `turns` of the turn that MISSED. */
  turnIndex: number;
  line: number;
  timestamp: number | null;
  model: string;
  previousModel: string;
  previousCacheRead: number;
  cacheRead: number;
  /** Tokens that were cached last turn but not served from cache this turn. */
  lostCachedTokens: number;
  /** `cacheRead / previousCacheRead` — 0 means the prefix matched nothing. */
  prefixMatchRatio: number;
  /** Matched-prefix length implied by this turn's `cacheRead` (≈ where the prefix diverged). */
  prefixMatchedTokens: number;
  previousPromptTokens: number;
  promptTokens: number;
  promptDelta: number;
  /** Gap from the previous counted turn, in ms. Null when timestamps are unusable. */
  gapMs: number | null;
  cause: BreakCause;
  /** Human-readable one-line explanation (Chinese). */
  detail: string;
  /** Extra dollars this turn cost versus a full cache hit on the same prompt. */
  extraCostUSD: number | null;
}

/** A `CacheBreak` annotated with the session it came from, for the overview list. */
export interface OverviewBreak extends CacheBreak {
  sessionId: string;
  projectPath: string;
}

/* ── Runtime telemetry (the transcript's own `cost-state` checkpoints) ────── */

export interface RuntimeModelUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  costUSD: number;
}

/**
 * The newest `cost-state` snapshot found in the transcript.
 *
 * Cumulative and runtime-authored, so it includes every model the session
 * process billed — subagents included. That is why `hitRate` here can differ
 * from the main-thread figure the rest of the panel reports; the two are shown
 * side by side rather than blended.
 */
export interface RuntimeState {
  /** False when the transcript carries no `cost-state` record at all. */
  present: boolean;
  /** How many cumulative checkpoints were found. */
  snapshots: number;
  startTime: number | null;
  /** API wall-clock, prefill included, tool execution excluded. */
  totalAPIDurationMs: number;
  totalAPIDurationWithoutRetriesMs: number;
  totalToolDurationMs: number;
  totalDurationMs: number;
  totalCostUSD: number;
  totalOutputTokens: number;
  promptTokens: number;
  cacheRead: number;
  cacheCreation: number;
  hitRate: number | null;
  models: RuntimeModelUsage[];
}

/**
 * How `outputTokensPerSecond` was derived. Rendered verbatim by the UI so the
 * number can never be read as a decode-only peak.
 */
export type RateBasis =
  /** output / API wall-clock — cc-haha's `tokensPerSecond` formula. */
  | 'api-duration'
  /** output / (session end - start). Includes tool time and idle; labelled as such. */
  | 'wall-clock'
  | 'unavailable';

export interface ModelBreakdown extends TokenCounts {
  model: string;
  turns: number;
  promptTokens: number;
  newTokens: number;
  hitRate: number | null;
  cost: CostBreakdown;
  /** null when we have no published rates for this model. */
  priced: boolean;
}

export interface SessionTotals extends TokenCounts {
  promptTokens: number;
  /** Uncached input + output. Cache reads excluded — they are not new spend. */
  newTokens: number;
  /** Sum(cacheRead) / Sum(promptTokens) — the billing-weighted session hit rate. */
  hitRate: number | null;
  /** Unweighted mean of per-turn hit rates; differs from `hitRate` on purpose. */
  meanTurnHitRate: number | null;
  turns: number;
  cost: CostBreakdown;
}

export interface SessionCounts {
  /** Total JSONL lines seen. */
  lines: number;
  /** Lines that parsed as JSON. */
  parsed: number;
  usageRows: number;
  /** Repeat lines for a reply already counted (a reply writes one line per content block). */
  duplicateRows: number;
  /** Sub-agent turns (`isSidechain: true`), excluded from session metrics. */
  sidechainRows: number;
  /** All-zero usage rows written for `<synthetic>` / interrupt / API-error turns. */
  zeroUsageRows: number;
  /** Lines copied into a forked session (`forkedFrom`). */
  forkedRows: number;
  malformedLines: number;
}

export interface TranscriptRef {
  /** Absolute path of the .jsonl file. */
  file: string;
  size: number;
  mtime: number;
  lineCount: number;
  /** True when only the tail of an oversized file was read. */
  truncated: boolean;
}

export interface SessionSummary {
  projectPath: string;
  /** Claude Code transcript id (the .jsonl basename without extension). */
  sessionId: string;
  transcript: TranscriptRef;
  startedAt: number | null;
  endedAt: number | null;
  totals: SessionTotals;
  models: ModelBreakdown[];
  turns: TurnMetrics[];
  breaks: CacheBreak[];
  counts: SessionCounts;
  /**
   * Output tokens per second, or null when no rate can be derived.
   * See `rateBasis` for what the denominator actually is.
   */
  outputTokensPerSecond: number | null;
  rateBasis: RateBasis;
  /** The transcript's own cumulative telemetry, for cross-checking. */
  runtime: RuntimeState;
  warnings: string[];
}

export interface SessionListItem {
  sessionId: string;
  file: string;
  size: number;
  mtime: number;
  /** True when the file was modified within the last 10 minutes. */
  active: boolean;
  /** Null when the probe could not parse the file cheaply. */
  startedAt: number | null;
  turns: number | null;
}

export interface SessionListResponse {
  projectPath: string;
  projectDirectory: string;
  sessions: SessionListItem[];
  warnings: string[];
}

export interface DayBucket extends TokenCounts {
  date: string;
  sessions: number;
  promptTokens: number;
  newTokens: number;
  hitRate: number | null;
  cost: CostBreakdown;
}

export interface OverviewResponse {
  scope: 'project' | 'all';
  projectPath: string | null;
  projectsScanned: number;
  sessions: number;
  skippedSessions: number;
  totals: SessionTotals;
  models: ModelBreakdown[];
  days: DayBucket[];
  breaks: OverviewBreak[];
  topBreakSessions: Array<{
    sessionId: string;
    projectPath: string;
    breaks: number;
    lostCachedTokens: number;
    hitRate: number | null;
  }>;
  warnings: string[];
}

export interface HealthResponse {
  ok: true;
  plugin: string;
  node: string;
  pid: number;
  /** Home directory the plugin resolved (HOME, falling back to USERPROFILE). */
  home: string;
  claudeProjectsDirectory: string;
  claudeProjectsExists: boolean;
  /** Number of project directories found under `~/.claude/projects`. */
  projectDirectories: number;
  cacheEntries: number;
  startedAt: number;
}

export interface ApiError {
  error: string;
  code: string;
  hint?: string;
}

/**
 * Compact one-line status, designed to be polled by a small UI chip.
 *
 * CloudCLI's plugin model has no status-bar slot, so nothing in the host renders
 * this today — it exists so that a host-side chip (or a statusLine script, or an
 * external poller) can get a session's cache numbers in ONE cheap request
 * instead of fetching and digesting the full `SessionSummary`.
 *
 * Repeated polls are served from the in-memory analysis cache, which is keyed by
 * transcript path + mtime + size, so an idle session costs no parsing.
 */
export interface StatusResponse {
  ok: true;
  /** False when there is no project, or no transcript to read. */
  available: boolean;
  reason?: string;
  projectPath: string | null;
  sessionId: string | null;
  transcriptFile: string | null;
  turnCount: number;
  /** The model that consumed the most prompt tokens. */
  model: string | null;
  hitRate: number | null;
  /** Output tokens per second. Null when no rate can be derived. */
  outputTokensPerSecond: number | null;
  /** What `outputTokensPerSecond` divides by — never assume it is decode-only. */
  rateBasis: RateBasis;
  /** API wall-clock from the transcript's own checkpoint, or null when absent. */
  apiDurationMs: number | null;
  toolDurationMs: number | null;
  sessionDurationMs: number | null;
  /** Runtime-authored cumulative hit rate (subagents included); null when absent. */
  runtimeHitRate: number | null;
  runtimeCostUSD: number | null;
  cacheRead: number;
  cacheCreation: number;
  promptTokens: number;
  newTokens: number;
  breaks: number;
  lostCachedTokens: number;
  /** Null when the session's models are not in the price table. */
  actualCostUSD: number | null;
  savedUSD: number | null;
  /** True when only the tail of an oversized transcript was analysed. */
  truncated: boolean;
  /** Ready-to-render chip label, e.g. `缓存命中 99.0%`. Consumers may ignore it. */
  chipText: string;
  /** Secondary line, e.g. `4 轮 · 缓存读 33.4M · 新 1.2M`. */
  detailText: string;
  updatedAt: number;
}
