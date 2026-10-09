/**
 * Turn extraction, session summarisation and cross-session overview.
 *
 * The extraction order below is the part that decides whether the numbers are
 * right; every step is a rule taken from cc-haha, and each one is counted so the
 * UI can show what was excluded instead of quietly dropping it.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import type {
  DayBucket,
  OverviewBreak,
  OverviewResponse,
  RateBasis,
  RuntimeState,
  SessionCounts,
  SessionSummary,
  TurnMetrics,
} from '../types.js';
import { detectBreaks, type BreakDetectionTurn } from './breaks.js';
import { formatCacheHitRate, hitRateOf, summarizeModels, summarizeTotals, tokensPerSecond, turnCost } from './metrics.js';
import { readRuntimeState } from './runtime.js';
import {
  claudeProjectsRoot,
  encodeProjectPath,
  listSessions,
  MAX_TRANSCRIPT_BYTES,
  parseTranscript,
  readTranscript,
  type ParsedTranscript,
} from './transcript.js';
import { isForkInheritedRecord, isRecord, normalizeUsage, promptTokens, usageRecordKey } from './usage.js';

/* ── Turn extraction ─────────────────────────────────────────────────────── */

/**
 * A compaction boundary record. Claude Code writes
 * `{ type: 'system', subtype: 'compact_boundary', compactMetadata: {...} }` and,
 * for the incremental variant, `subtype: 'microcompact_boundary'`.
 *
 * Both remove messages on purpose, so the next turn's cache read is expected to
 * fall. cc-haha calls `notifyCompaction()` (full compact) and
 * `notifyCacheDeletion()` (microcompact) to reset its baseline for exactly this
 * reason — here the same two cases suppress a break.
 */
export function isCompactionBoundary(record: Record<string, unknown>): boolean {
  if (record.type !== 'system') return false;
  return record.subtype === 'compact_boundary' || record.subtype === 'microcompact_boundary';
}

function readTimestamp(record: Record<string, unknown>): number | null {
  const raw = record.timestamp;
  if (typeof raw !== 'string') return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readModel(record: Record<string, unknown>): string {
  const message = record.message;
  if (isRecord(message) && typeof message.model === 'string' && message.model) {
    return message.model;
  }
  return '(unknown)';
}

function readSpeed(record: Record<string, unknown>, usage: Record<string, unknown>): string | undefined {
  if (typeof record.speed === 'string') return record.speed;
  if (typeof usage.speed === 'string') return usage.speed;
  return undefined;
}

export interface ExtractionResult {
  turns: BreakDetectionTurn[];
  counts: SessionCounts;
  compactionBoundaries: number;
  startedAt: number | null;
  endedAt: number | null;
}

/**
 * Walk a parsed transcript and produce the counted turns.
 *
 * Order matters and mirrors cc-haha's `isBillableUsageRecord` →
 * `isForkInheritedUsageRecord` → `usageRecordKey` pipeline:
 *
 *   1. compaction boundaries reset the "expected a hit" state
 *   2. only `type: 'assistant'` records carry a billable `usage`
 *   3. all-zero usage rows are `<synthetic>` turns (interrupts, API errors,
 *      "No response requested") — they never carried a prompt
 *   4. `isSidechain` rows are sub-agent turns reporting the SUB-agent's context
 *   5. `forkedFrom` rows were copied into this transcript from another session
 *   6. duplicates share `message.id` + `requestId` — one reply writes one line
 *      per content block, each repeating the whole `usage` object
 */
export function extractTurns(parsed: ParsedTranscript): ExtractionResult {
  const turns: BreakDetectionTurn[] = [];
  const counts: SessionCounts = {
    lines: parsed.totalLines,
    parsed: parsed.lines.length,
    usageRows: 0,
    duplicateRows: 0,
    sidechainRows: 0,
    zeroUsageRows: 0,
    forkedRows: 0,
    malformedLines: parsed.malformed,
  };

  const seenKeys = new Set<string>();
  let compactionBoundaries = 0;
  let pendingCompaction = false;
  let startedAt: number | null = null;
  let endedAt: number | null = null;

  for (const { line, record } of parsed.lines) {
    if (isCompactionBoundary(record)) {
      compactionBoundaries += 1;
      // Everything after a boundary is a rebuilt prefix; the first usage-bearing
      // turn must not be compared against the pre-compaction baseline.
      pendingCompaction = true;
      continue;
    }

    if (record.type !== 'assistant') continue;
    const message = record.message;
    if (!isRecord(message)) continue;
    const usage = message.usage;
    if (!isRecord(usage)) continue;
    counts.usageRows += 1;

    const normalized = normalizeUsage(usage);
    const rowPrompt = promptTokens(normalized);

    // `<synthetic>` rows are written with a complete all-zero usage block rather
    // than no usage block at all. CloudCLI's reader skips them for the same
    // reason: treating one as the newest turn zeroes a counter that is correct.
    if (rowPrompt === 0 && normalized.output === 0) {
      counts.zeroUsageRows += 1;
      continue;
    }

    if (record.isSidechain === true) {
      counts.sidechainRows += 1;
      continue;
    }

    if (isForkInheritedRecord(record)) {
      counts.forkedRows += 1;
      continue;
    }

    const key = usageRecordKey({
      version: record.version,
      sessionId: record.sessionId,
      requestId: record.requestId,
      messageId: message.id,
      forkedFrom: record.forkedFrom,
    });
    if (key !== null) {
      if (seenKeys.has(key)) {
        counts.duplicateRows += 1;
        continue;
      }
      seenKeys.add(key);
    }

    const timestamp = readTimestamp(record);
    if (timestamp !== null) {
      if (startedAt === null || timestamp < startedAt) startedAt = timestamp;
      if (endedAt === null || timestamp > endedAt) endedAt = timestamp;
    }

    const model = readModel(record);
    const tokens = {
      input: normalized.input,
      output: normalized.output,
      cacheRead: normalized.cacheRead,
      cacheCreation: normalized.cacheCreation,
    };

    turns.push({
      index: turns.length,
      line,
      timestamp,
      model,
      ...tokens,
      promptTokens: rowPrompt,
      newTokens: tokens.input + tokens.output,
      hitRate: hitRateOf(tokens),
      cost: turnCost(model, tokens, readSpeed(record, usage)),
      afterCompaction: pendingCompaction,
    });
    pendingCompaction = false;
  }

  return { turns, counts, compactionBoundaries, startedAt, endedAt };
}

/* ── Session summary ─────────────────────────────────────────────────────── */

interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
}

const sessionCache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 24;

export function cacheEntryCount(): number {
  return sessionCache.size;
}

export function clearAnalysisCache(): void {
  sessionCache.clear();
}

export interface SummarizeOptions {
  file: string;
  sessionId: string;
  projectPath: string;
  /** Bypass the in-memory cache. */
  force?: boolean;
}

export async function summarizeSessionFile(options: SummarizeOptions): Promise<SessionSummary> {
  const stats = await fsp.stat(options.file);

  if (!options.force) {
    const cached = sessionCache.get(options.file);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      // Re-stamp the identity in case the caller asked with a different label.
      return { ...cached.summary, projectPath: options.projectPath, sessionId: options.sessionId };
    }
  }

  const read = await readTranscript(options.file);
  const parsed = parseTranscript(read.text, read.truncated);
  const extraction = extractTurns(parsed);
  const { breaks, warnings } = detectBreaks(extraction.turns);
  const totals = summarizeTotals(extraction.turns);

  /*
   * Output rate. Preferred denominator is the runtime's own API wall-clock,
   * which is cc-haha's formula. Only when the transcript carries no `cost-state`
   * checkpoint — two of three real transcripts I sampled had none — do we fall
   * back to the session span, and then the basis is labelled so the UI can say
   * what the number actually divides by.
   */
  const runtime = readRuntimeState(parsed.lines);
  let outputTokensPerSecond = tokensPerSecond(runtime.totalOutputTokens, runtime.totalAPIDurationMs);
  let rateBasis: RateBasis = outputTokensPerSecond === null ? 'unavailable' : 'api-duration';

  if (outputTokensPerSecond === null) {
    const spanMs =
      extraction.startedAt !== null && extraction.endedAt !== null && extraction.endedAt > extraction.startedAt
        ? extraction.endedAt - extraction.startedAt
        : 0;
    outputTokensPerSecond = tokensPerSecond(totals.output, spanMs);
    if (outputTokensPerSecond !== null) rateBasis = 'wall-clock';
  }

  const summary: SessionSummary = {
    projectPath: options.projectPath,
    sessionId: options.sessionId,
    transcript: {
      file: options.file,
      size: read.size,
      mtime: stats.mtimeMs,
      lineCount: parsed.totalLines,
      truncated: read.truncated,
    },
    startedAt: extraction.startedAt,
    endedAt: extraction.endedAt,
    totals,
    models: summarizeModels(extraction.turns),
    turns: extraction.turns.map(stripDetectionFields),
    breaks,
    counts: extraction.counts,
    outputTokensPerSecond,
    rateBasis,
    runtime,
    warnings,
  };

  if (read.truncated) {
    summary.warnings.push(
      `transcript 超过 ${Math.round(MAX_TRANSCRIPT_BYTES / 1024 / 1024)}MB，仅分析了末尾部分（跳过前 ${Math.round(read.skippedBytes / 1024 / 1024)}MB）。累计数字是"最近一段"而非全会话。`,
    );
  }
  if (extraction.counts.duplicateRows > 0) {
    summary.warnings.push(
      `已按 cc-haha 口径去重 ${extraction.counts.duplicateRows} 行：一次回复的每个 content block 各写一行 JSONL，且每行重复完整 usage；逐行求和会把真实用量放大约 2.2 倍。`,
    );
  }
  if (extraction.counts.sidechainRows > 0) {
    summary.warnings.push(`已排除 ${extraction.counts.sidechainRows} 行子 agent（isSidechain）用量，它们统计的是子 agent 自己的上下文。`);
  }
  if (extraction.counts.zeroUsageRows > 0) {
    summary.warnings.push(`已跳过 ${extraction.counts.zeroUsageRows} 行全零 usage（<synthetic>：中断 / API 错误 / 无响应请求）。`);
  }
  if (extraction.counts.forkedRows > 0) {
    summary.warnings.push(`已排除 ${extraction.counts.forkedRows} 行 fork 继承的用量，这些 API 调用属于源会话。`);
  }
  if (extraction.compactionBoundaries > 0) {
    summary.warnings.push(`检测到 ${extraction.compactionBoundaries} 处压缩边界（compact / microcompact），其后的缓存下降不计为断裂。`);
  }
  if (extraction.counts.malformedLines > 0) {
    summary.warnings.push(`有 ${extraction.counts.malformedLines} 行无法解析 JSON（会话正在写入时读到半行属正常）。`);
  }
  const unpriced = summary.models.filter((model) => !model.priced);
  if (unpriced.length > 0) {
    summary.warnings.push(
      `以下模型没有公开定价，已从成本合计中排除（cc-haha 同样拒绝用 Claude 价格给第三方模型计价）：${unpriced.map((m) => m.model).join(', ')}`,
    );
  }

  if (rateBasis === 'wall-clock') {
    summary.warnings.push(
      `该 transcript 没有 cost-state 快照，无法用 API 耗时计算输出速率。当前的 tok/s 用的是会话时间跨度（含工具执行与空闲），会明显低于真实解码速度 —— 仅作趋势参考，不要当作生成速度。`,
    );
  } else if (rateBasis === 'unavailable') {
    summary.warnings.push('无法计算输出速率：transcript 既没有 cost-state 快照，也没有可用的时间跨度。');
  }

  if (runtime.present) {
    const delta = runtime.hitRate !== null && totals.hitRate !== null ? Math.abs(runtime.hitRate - totals.hitRate) : null;
    if (delta !== null && delta >= 0.02) {
      summary.warnings.push(
        `运行时累计命中率 ${formatCacheHitRate(runtime.hitRate)} 与本页主线程口径 ${formatCacheHitRate(totals.hitRate)} 相差 ${(delta * 100).toFixed(1)} 个百分点。两者都对：前者是 Claude Code 自己按会话累计、包含子 agent 等全部模型的计费视角，后者是本页按主线程逐轮提取并去重后的口径。`,
      );
    }
  }

  sessionCache.set(options.file, { mtimeMs: stats.mtimeMs, size: stats.size, summary });
  if (sessionCache.size > MAX_CACHE_ENTRIES) {
    const oldest = sessionCache.keys().next().value;
    if (oldest !== undefined) sessionCache.delete(oldest);
  }

  return summary;
}

function stripDetectionFields(turn: BreakDetectionTurn): TurnMetrics {
  const { afterCompaction: _afterCompaction, ...rest } = turn;
  return rest;
}

/* ── Project / global overview ───────────────────────────────────────────── */

const MAX_OVERVIEW_SESSIONS = 60;

function dayKey(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface OverviewOptions {
  home: string;
  /** Restrict to one project, or scan every directory under `~/.claude/projects`. */
  projectPath?: string | null;
}

export async function buildOverview(options: OverviewOptions): Promise<OverviewResponse> {
  const root = claudeProjectsRoot(options.home);
  const directories: Array<{ directory: string; projectPath: string | null }> = [];

  if (options.projectPath) {
    directories.push({
      directory: path.join(root, encodeProjectPath(path.resolve(options.projectPath))),
      projectPath: path.resolve(options.projectPath),
    });
  } else {
    let names: string[] = [];
    try {
      names = (await fsp.readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      names = [];
    }
    for (const name of names) directories.push({ directory: path.join(root, name), projectPath: null });
  }

  const warnings: string[] = [];
  const allTurns: TurnMetrics[] = [];
  const dayAccumulator = new Map<string, { turns: TurnMetrics[]; sessionFiles: Set<string> }>();
  const sessionAggregates = new Map<string, SessionAggregate>();
  const allBreaks: OverviewBreak[] = [];
  let sessions = 0;
  let skipped = 0;

  for (const entry of directories) {
    const items = await listSessions(entry.directory);
    for (const item of items.slice(0, MAX_OVERVIEW_SESSIONS)) {
      const projectPath = entry.projectPath ?? entry.directory;
      try {
        const summary = await summarizeSessionFile({
          file: item.file,
          sessionId: item.sessionId,
          projectPath,
        });
        sessions += 1;
        for (const turn of summary.turns) allTurns.push(turn);

        const aggregate: SessionAggregate = {
          sessionId: item.sessionId,
          projectPath,
          turns: summary.turns,
          breaks: [],
          lostCachedTokens: 0,
        };
        for (const brk of summary.breaks) {
          const annotated: OverviewBreak = { ...brk, sessionId: item.sessionId, projectPath };
          aggregate.breaks.push(annotated);
          aggregate.lostCachedTokens += brk.lostCachedTokens;
          allBreaks.push(annotated);
        }
        sessionAggregates.set(item.file, aggregate);

        for (const turn of summary.turns) {
          if (turn.timestamp === null) continue;
          const date = dayKey(turn.timestamp);
          let day = dayAccumulator.get(date);
          if (!day) {
            day = { turns: [], sessionFiles: new Set<string>() };
            dayAccumulator.set(date, day);
          }
          day.turns.push(turn);
          day.sessionFiles.add(item.file);
        }
      } catch (error) {
        skipped += 1;
        // Report an aggregate count rather than flooding the panel.
        if (skipped <= 3) warnings.push(`跳过 ${path.basename(item.file)}：${(error as Error).message}`);
      }
    }
    if (items.length > MAX_OVERVIEW_SESSIONS) {
      warnings.push(
        `目录 ${path.basename(entry.directory)} 下有 ${items.length} 个会话，仅汇总了最新的 ${MAX_OVERVIEW_SESSIONS} 个。`,
      );
    }
  }

  const days: DayBucket[] = [];
  const sortedDays = [...dayAccumulator.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  for (const [date, day] of sortedDays) {
    const totals = summarizeTotals(day.turns);
    days.push({
      date,
      sessions: day.sessionFiles.size,
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheCreation: totals.cacheCreation,
      promptTokens: totals.promptTokens,
      newTokens: totals.newTokens,
      hitRate: totals.hitRate,
      cost: totals.cost,
    });
  }

  const topBreakSessions = [...sessionAggregates.values()]
    .filter((aggregate) => aggregate.breaks.length > 0)
    .sort((a, b) => b.lostCachedTokens - a.lostCachedTokens)
    .slice(0, 10)
    .map((aggregate) => ({
      sessionId: aggregate.sessionId,
      projectPath: aggregate.projectPath,
      breaks: aggregate.breaks.length,
      lostCachedTokens: aggregate.lostCachedTokens,
      hitRate: summarizeTotals(aggregate.turns).hitRate,
    }));

  return {
    scope: options.projectPath ? 'project' : 'all',
    projectPath: options.projectPath ?? null,
    projectsScanned: directories.length,
    sessions,
    skippedSessions: skipped,
    totals: summarizeTotals(allTurns),
    models: summarizeModels(allTurns),
    days,
    // Newest first, capped: the UI lists the most recent breaks, not history.
    breaks: allBreaks.slice(-50).reverse(),
    topBreakSessions,
    warnings,
  };
}

interface SessionAggregate {
  sessionId: string;
  projectPath: string;
  turns: TurnMetrics[];
  breaks: OverviewBreak[];
  lostCachedTokens: number;
}
