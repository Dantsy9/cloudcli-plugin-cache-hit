/**
 * Plugin frontend module — the tab UI.
 *
 * IMPORTANT: this file must not contain any *runtime* relative import.
 * The host fetches the compiled entry and imports it from a `Blob` URL
 * (`src/modules/plugins/PluginTabContent.tsx`), and `blob:` URLs have no
 * directory, so `import './x.js'` would fail to resolve. `import type` is erased
 * by tsc and is therefore safe. All formatting helpers are inlined below for the
 * same reason; the heavy computation lives in the backend server.
 */

import type {
  CacheBreak,
  HealthResponse,
  OverviewResponse,
  PluginAPI,
  PluginContext,
  RateBasis,
  SessionListItem,
  SessionListResponse,
  SessionSummary,
  TurnMetrics,
} from './types.js';

/* ── Formatting (mirrors the server-side rules in analyze/metrics.ts) ────── */

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Never round a partial hit up to a flat 100%. A session at 99.96% is not fully
 * cached, and printing "100%" would misstate both the bill and prompt stability —
 * the same rule cc-haha uses in `formatCacheHitRate()`.
 */
function fmtRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return '0%';
  if (rate >= 1) return '100%';
  const percent = rate * 100;
  const one = percent.toFixed(1);
  if (one !== '100.0') return `${one}%`;
  const two = percent.toFixed(2);
  return two === '100.00' ? '99.99%' : `${two}%`;
}

function fmtCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return '0';
  if (value < 1000) return String(Math.round(value));
  const thousands = value / 1000;
  const decimals = thousands >= 100 ? 0 : 1;
  if (Number(thousands.toFixed(decimals)) >= 1000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${thousands.toFixed(decimals)}K`;
}

function fmtFull(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--';
  return Math.round(value).toLocaleString('en-US');
}

function fmtUSD(value: number | null, digits = 4): string {
  if (value === null || !Number.isFinite(value)) return '--';
  if (value === 0) return '$0';
  if (Math.abs(value) < 0.0001) return value > 0 ? '<$0.0001' : '>-$0.0001';
  if (Math.abs(value) >= 100) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(digits)}`;
}

function fmtGap(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '--';
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
}

function fmtClock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '--';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * `10-09`, or `2025-10-09` when the year is not the current one.
 *
 * Comparing against the current year rather than the session's is deliberate: a
 * timestamp shown without its year is only unambiguous inside the current year.
 */
function fmtDay(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const md = `${month}-${day}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/**
 * `10-09 11:47:09` — a bare clock time is never enough.
 *
 * A transcript can be resumed days later, and a long session can cross midnight,
 * so `11:47:09` alone leaves the reader unable to tell which day a cache break
 * happened on. The date is therefore always present.
 */
function fmtStamped(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '--';
  return `${fmtDay(ms)} ${fmtClock(ms)}`;
}

/** `10-09 10:58 → 11:01`, or both sides dated when the range crosses a day. */
function fmtRange(start: number | null, end: number | null): string {
  if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end)) {
    return `${fmtClock(start)} → ${fmtClock(end)}`;
  }
  if (fmtDay(start) === fmtDay(end)) return `${fmtDay(start)} ${fmtClock(start)} → ${fmtClock(end)}`;
  return `${fmtStamped(start)} → ${fmtStamped(end)}`;
}

/**
 * `10-09 17:07` — date plus minute precision, for list rows.
 *
 * The session picker used to show a relative age only ("47 天前"), which is
 * exactly the case where a reader needs the calendar date.
 */
function fmtDayMinute(ms: number): string {
  return `${fmtDay(ms)} ${fmtClock(ms).slice(0, 5)}`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** `283` / `9.4` / `--` — mirrors cc-haha's `formatTokensPerSecond()`. */
function fmtTokPerSec(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return '--';
  return value >= 10 ? `${Math.round(value)}` : value.toFixed(1);
}

/**
 * What the output rate actually divides by. Rendered next to the number so it
 * can never be mistaken for a decode-only peak.
 */
function rateBasisNote(basis: RateBasis, toolMs?: number | null): string {
  switch (basis) {
    case 'api-duration':
      return '输出 ÷ API 累计耗时（含 prefill，不含工具执行）';
    case 'wall-clock':
      return '无 cost-state 快照：用会话跨度，含工具与空闲，仅作趋势参考';
    default:
      return toolMs === 0 ? '无法计算：transcript 缺少 API 耗时' : '无法计算：transcript 缺少 API 耗时';
  }
}

function basename(p: string | undefined | null): string {
  if (!p) return '';
  const trimmed = p.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/** Claude Code's project-directory encoding; must match the server exactly. */
function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
}

/* ── Styles & theme tokens ──────────────────────────────────────────────── */

interface Palette {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  good: string;
  warn: string;
  bad: string;
  info: string;
}

function palette(dark: boolean): Palette {
  return dark
    ? {
        bg: '#0d0d11',
        surface: '#16161d',
        surfaceAlt: '#1d1d26',
        border: '#26262f',
        text: '#e8e6f0',
        muted: '#9a97b5',
        faint: '#5b5876',
        accent: '#7c6cf0',
        good: '#34d399',
        warn: '#fbbf24',
        bad: '#f87171',
        info: '#60a5fa',
      }
    : {
        bg: '#fafaf8',
        surface: '#ffffff',
        surfaceAlt: '#f4f3f7',
        border: '#e5e3ec',
        text: '#191825',
        muted: '#6b6880',
        faint: '#a5a2b8',
        accent: '#5b4bd6',
        good: '#0f9d6e',
        warn: '#b45309',
        bad: '#dc2626',
        info: '#2563eb',
      };
}

const STYLE_ID = 'cache-hit-styles';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.ch-root { box-sizing: border-box; padding: 20px 24px 40px; min-height: 100%; }
.ch-root *, .ch-root *::before, .ch-root *::after { box-sizing: border-box; }
.ch-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ch-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
.ch-title { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.ch-sub { font-size: 12px; margin-top: 3px; }
.ch-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ch-grid { display: grid; gap: 10px; margin-bottom: 16px; }
.ch-grid-6 { grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); }
.ch-grid-2 { grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); }
.ch-card { border: 1px solid; border-radius: 8px; padding: 14px 16px; }
.ch-kpi-value { font-size: 22px; font-weight: 600; line-height: 1.1; letter-spacing: -0.02em; }
.ch-kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 6px; }
.ch-kpi-note { font-size: 11px; margin-top: 4px; }
.ch-section { border: 1px solid; border-radius: 8px; margin-bottom: 14px; overflow: hidden; }
.ch-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 16px; border-bottom: 1px solid; font-size: 12px; font-weight: 600; letter-spacing: 0.03em; }
.ch-section-body { padding: 14px 16px; }
.ch-btn { border: 1px solid; border-radius: 6px; padding: 5px 11px; font-size: 12px; cursor: pointer; background: transparent; font-family: inherit; transition: border-color .15s, color .15s; }
.ch-btn:hover { border-color: currentColor; }
.ch-btn:disabled { opacity: .45; cursor: default; }
.ch-select { border: 1px solid; border-radius: 6px; padding: 5px 8px; font-size: 12px; max-width: 340px; font-family: inherit; }
.ch-chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid; border-radius: 999px; padding: 1px 8px; font-size: 11px; white-space: nowrap; }
.ch-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.ch-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ch-table th { text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; padding: 6px 10px 6px 0; border-bottom: 1px solid; white-space: nowrap; }
.ch-table td { padding: 6px 10px 6px 0; border-bottom: 1px solid; vertical-align: top; }
/* Numeric header cells must match their right-aligned values.
   '.ch-table th' is specificity (0,1,1) and outranks a bare '.ch-num' (0,1,0),
   so the alignment has to be restated at equal specificity. Without this rule
   every numeric header stays left-aligned while its column's values hug the
   right edge — measured in Chrome, th computed text-align: left against a
   text-align: right td, which is what made the whole table read as shifted. */
.ch-table th.ch-num, .ch-table td.ch-num { text-align: right; }
.ch-table tr:last-child td { border-bottom: none; }
.ch-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ch-break-detail { font-size: 11.5px; line-height: 1.55; max-width: 620px; }
.ch-empty { padding: 40px 24px; text-align: center; font-size: 13px; line-height: 1.7; }
.ch-warn { font-size: 11.5px; line-height: 1.65; padding: 7px 0; display: flex; gap: 7px; }
.ch-note { font-size: 11.5px; line-height: 1.7; }
.ch-details summary { cursor: pointer; font-size: 12px; font-weight: 600; }
.ch-details[open] summary { margin-bottom: 10px; }
.ch-scroll { overflow-x: auto; }
.ch-kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; font-size: 11.5px; }
/* Three tracks for label | value | note. The value gets its own track so the
   numbers form one aligned column; putting the value and its note in a single
   right-aligned cell pushed each value left by the width of its note, so rows
   with a note never lined up with rows without one. */
.ch-kv3 { display: grid; grid-template-columns: auto minmax(3.5rem, max-content) 1fr; gap: 3px 14px; font-size: 11.5px; }
`;
  document.head.appendChild(style);
}

/* ── Charts ─────────────────────────────────────────────────────────────── */

const CHART_MAX_TURNS = 320;

function renderTurnChart(turns: TurnMetrics[], breaks: CacheBreak[], c: Palette, width: number): string {
  if (turns.length === 0) return '';
  // Sample down rather than let a 2000-turn session turn into a barcode.
  const step = Math.max(1, Math.ceil(turns.length / CHART_MAX_TURNS));
  const sampled: TurnMetrics[] = [];
  for (let i = 0; i < turns.length; i += step) sampled.push(turns[i]!);

  const height = 132;
  const padBottom = 18;
  const plotHeight = height - padBottom;
  const maxPrompt = Math.max(...sampled.map((t) => t.promptTokens), 1);
  const barWidth = Math.max(1.5, (width - 8) / sampled.length - 1);
  const gap = 1;
  const breakIndices = new Set(breaks.map((b) => b.turnIndex));

  const bars: string[] = [];
  for (let i = 0; i < sampled.length; i += 1) {
    const turn = sampled[i]!;
    const x = 4 + i * (barWidth + gap);
    const totalHeight = Math.max(2, (turn.promptTokens / maxPrompt) * plotHeight);
    const cachedHeight = Math.max(0, (turn.cacheRead / maxPrompt) * plotHeight);
    const y = plotHeight - totalHeight;

    bars.push(
      `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${totalHeight.toFixed(2)}" fill="${c.surfaceAlt}" rx="1"><title>轮次 #${turn.index + 1} · prompt ${fmtFull(turn.promptTokens)} · 命中 ${fmtRate(turn.hitRate)} · ${esc(turn.model)}</title></rect>`,
    );
    if (cachedHeight > 0) {
      bars.push(
        `<rect x="${x.toFixed(2)}" y="${(plotHeight - cachedHeight).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${cachedHeight.toFixed(2)}" fill="${c.accent}" rx="1" opacity="0.85"/>`,
      );
    }
    if (breakIndices.has(turn.index)) {
      bars.push(
        `<rect x="${(x - 0.5).toFixed(2)}" y="0" width="${Math.max(1.5, barWidth + 1).toFixed(2)}" height="5" fill="${c.bad}" rx="1"><title>断裂：轮次 #${turn.index + 1}</title></rect>`,
      );
    }
  }

  // Hit-rate polyline on top of the bars: the shape is the story.
  const points: string[] = [];
  for (let i = 0; i < sampled.length; i += 1) {
    const turn = sampled[i]!;
    if (turn.hitRate === null) continue;
    const x = 4 + i * (barWidth + gap) + barWidth / 2;
    const y = plotHeight - turn.hitRate * plotHeight;
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }

  const first = sampled[0]!;
  const last = sampled[sampled.length - 1]!;

  return `
<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" role="img" aria-label="逐轮缓存命中率">
  <line x1="0" y1="${plotHeight}" x2="${width}" y2="${plotHeight}" stroke="${c.border}" stroke-width="1"/>
  ${bars.join('')}
  ${points.length > 1 ? `<polyline points="${points.join(' ')}" fill="none" stroke="${c.good}" stroke-width="1.4" opacity="0.9"/>` : ''}
  <text x="4" y="${height - 5}" fill="${c.faint}" font-size="10">#${first.index + 1}</text>
  <text x="${width - 4}" y="${height - 5}" fill="${c.faint}" font-size="10" text-anchor="end">#${last.index + 1}</text>
</svg>
<div class="ch-note" style="color:${c.faint};margin-top:4px">
  灰柱 = 该轮 prompt 总量，紫柱 = 其中命中缓存的部分，绿线 = 命中率，顶部红块 = 检测到缓存断裂。
  ${step > 1 ? `已按每 ${step} 轮抽样显示（共 ${turns.length} 轮）。` : ''}
</div>`;
}

function causeColor(cause: CacheBreak['cause'], c: Palette): string {
  switch (cause) {
    case 'model_changed':
    case 'prefix_changed':
      return c.bad;
    case 'ttl_1h':
    case 'ttl_5m':
      return c.warn;
    case 'server_side':
      return c.info;
    case 'compaction':
    case 'cold_start':
      return c.muted;
    default:
      return c.muted;
  }
}

function causeLabel(cause: CacheBreak['cause']): string {
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

/* ── Mount ──────────────────────────────────────────────────────────────── */

interface ViewState {
  context: PluginContext;
  /**
   * Identity of the context the current data belongs to.
   *
   * Compared as scalars rather than by object reference: `api.context` is
   * documented as "always returns the latest values", and a host that mutated
   * its context object in place would make a reference comparison see no change
   * and silently keep showing another project's numbers.
   */
  contextProjectPath: string | null;
  contextAppSessionId: string | null;
  sessions: SessionListItem[];
  sessionId: string | null;
  summary: SessionSummary | null;
  overview: OverviewResponse | null;
  health: HealthResponse | null;
  scope: 'session' | 'overview';
  overviewAll: boolean;
  loading: boolean;
  error: { message: string; hint?: string } | null;
  autoRefresh: boolean;
  lastLoadedAt: number | null;
}

const AUTO_REFRESH_MS = 20_000;

export function mount(container: HTMLElement, api: PluginAPI): void {
  ensureStyles();

  const state: ViewState = {
    context: api.context,
    contextProjectPath: api.context.project?.path ?? null,
    contextAppSessionId: api.context.session?.id ?? null,
    sessions: [],
    sessionId: null,
    summary: null,
    overview: null,
    health: null,
    scope: 'session',
    overviewAll: false,
    loading: false,
    error: null,
    autoRefresh: true,
    lastLoadedAt: null,
  };

  const root = document.createElement('div');
  root.className = 'ch-root';
  container.appendChild(root);

  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let inFlight = false;

  /* ── data ─────────────────────────────────────────────────────────────── */

  async function call<T>(path: string): Promise<T> {
    return (await api.rpc('GET', path)) as T;
  }

  function query(params: Record<string, string | null | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && value !== '') search.set(key, value);
    }
    const text = search.toString();
    return text ? `?${text}` : '';
  }

  async function probeHealth(): Promise<void> {
    try {
      state.health = await call<HealthResponse>('health');
    } catch {
      state.health = null;
    }
  }

  async function loadOverview(): Promise<void> {
    const projectPath = state.context.project?.path ?? null;
    state.overview = await call<OverviewResponse>(
      `overview${query({ projectPath: state.overviewAll ? null : projectPath, all: state.overviewAll ? '1' : null })}`,
    );
  }

  async function loadSessions(): Promise<void> {
    const projectPath = state.context.project?.path;
    if (!projectPath) {
      state.sessions = [];
      state.sessionId = null;
      state.summary = null;
      return;
    }
    const response = await call<SessionListResponse>(`sessions${query({ projectPath })}`);
    state.sessions = response.sessions;
    const stillThere = state.sessionId && response.sessions.some((s) => s.sessionId === state.sessionId);
    if (!stillThere) state.sessionId = response.sessions[0]?.sessionId ?? null;
  }

  async function loadSummary(force = false): Promise<void> {
    const projectPath = state.context.project?.path;
    if (!projectPath) {
      state.summary = null;
      return;
    }
    state.summary = await call<SessionSummary>(
      `session${query({ projectPath, sessionId: state.sessionId, force: force ? '1' : null })}`,
    );
    if (state.summary) state.sessionId = state.summary.sessionId;
  }

  async function refresh(force: boolean): Promise<void> {
    if (inFlight || disposed) return;
    inFlight = true;
    state.loading = true;
    state.error = null;
    render();

    try {
      if (!state.health) await probeHealth();
      if (state.scope === 'overview') {
        await loadOverview();
      } else {
        await loadSessions();
        await loadSummary(force);
      }
      state.lastLoadedAt = Date.now();
    } catch (error) {
      const payload = error as Error & { hint?: string };
      state.error = { message: payload.message || String(error), hint: payload.hint };
    } finally {
      state.loading = false;
      inFlight = false;
      if (!disposed) render();
    }
  }

  /* ── render ───────────────────────────────────────────────────────────── */

  function render(): void {
    if (disposed) return;
    const c = palette(state.context.theme === 'dark');
    root.style.background = c.bg;
    root.style.color = c.text;

    root.innerHTML = `
      ${renderHeader(c)}
      ${renderBody(c)}
    `;

    wire();
  }

  function renderHeader(c: Palette): string {
    const project = state.context.project;
    const projectLabel = project ? basename(project.path) || project.name : '未选择项目';

    const sessionOptions = state.sessions
      .map((item) => {
        const label = `${item.sessionId.slice(0, 8)} · ${fmtDayMinute(item.mtime)} · ${fmtBytes(item.size)}${item.active ? ' · ● 活动' : ''}`;
        const selected = item.sessionId === state.sessionId ? ' selected' : '';
        return `<option value="${esc(item.sessionId)}"${selected}>${esc(label)}</option>`;
      })
      .join('');

    const tabs: Array<[ViewState['scope'], string]> = [
      ['session', '单会话分析'],
      ['overview', '多会话汇总'],
    ];

    return `
<div class="ch-head">
  <div style="min-width:0">
    <div class="ch-title" style="color:${c.text}">缓存命中</div>
    <div class="ch-sub" style="color:${c.muted}">
      ${esc(projectLabel)}
      ${project ? `<span class="ch-mono" style="color:${c.faint}"> · ${esc(project.path)}</span>` : ''}
      ${state.lastLoadedAt ? `<span style="color:${c.faint}"> · 更新于 ${fmtClock(state.lastLoadedAt)}</span>` : ''}
    </div>
  </div>
  <div class="ch-row">
    ${tabs
      .map(
        ([scope, label]) =>
          `<button class="ch-btn" data-scope="${scope}" style="border-color:${state.scope === scope ? c.accent : c.border};color:${state.scope === scope ? c.accent : c.muted}">${label}</button>`,
      )
      .join('')}
    ${
      state.scope === 'session'
        ? `<select class="ch-select" id="ch-session" style="background:${c.surface};border-color:${c.border};color:${c.text}" ${state.sessions.length === 0 ? 'disabled' : ''}>
             ${sessionOptions || '<option>暂无会话</option>'}
           </select>`
        : `<label class="ch-note" style="color:${c.muted};display:inline-flex;align-items:center;gap:6px">
             <input type="checkbox" id="ch-all"${state.overviewAll ? ' checked' : ''}/> 全部项目
           </label>`
    }
    <button class="ch-btn" id="ch-auto" style="border-color:${c.border};color:${state.autoRefresh ? c.good : c.muted}">
      ${state.autoRefresh ? '自动刷新 开' : '自动刷新 关'}
    </button>
    <button class="ch-btn" id="ch-refresh" style="border-color:${c.border};color:${c.muted}" ${state.loading ? 'disabled' : ''}>
      ${state.loading ? '分析中…' : '重新分析'}
    </button>
  </div>
</div>`;
  }

  function renderBody(c: Palette): string {
    if (state.error) return renderError(c);
    if (!state.context.project && state.scope === 'session') return renderNoProject(c);
    if (state.scope === 'overview') return state.overview ? renderOverview(c, state.overview) : renderLoading(c);
    if (!state.summary && state.loading) return renderLoading(c);
    if (!state.summary) return renderEmpty(c);
    return renderSession(c, state.summary);
  }

  function renderLoading(c: Palette): string {
    return `<div class="ch-empty" style="color:${c.muted}">正在读取 transcript 并计算…</div>`;
  }

  function renderError(c: Palette): string {
    const error = state.error!;
    return `
<div class="ch-empty" style="color:${c.bad}">
  <div style="font-weight:600;margin-bottom:6px">分析失败</div>
  <div>${esc(error.message)}</div>
  ${error.hint ? `<div class="ch-note" style="color:${c.muted};margin-top:10px">${esc(error.hint)}</div>` : ''}
</div>`;
  }

  function renderNoProject(c: Palette): string {
    return `
<div class="ch-empty" style="color:${c.muted}">
  <div style="font-size:15px;color:${c.text};margin-bottom:8px">请在 CloudCLI 中选择一个项目</div>
  <div>插件通过 <span class="ch-mono">api.context.project.path</span> 定位 Claude Code 的 transcript 目录。</div>
  <div class="ch-note" style="margin-top:10px;color:${c.faint}">
    读取路径：<span class="ch-mono">$HOME/.claude/projects/&lt;项目路径编码&gt;/&lt;会话id&gt;.jsonl</span>
  </div>
</div>`;
  }

  function renderEmpty(c: Palette): string {
    const health = state.health;
    return `
<div class="ch-empty" style="color:${c.muted}">
  <div style="color:${c.text};margin-bottom:8px">该项目下没有找到可分析的 transcript</div>
  ${health ? `<div class="ch-note">已查找：<span class="ch-mono">${esc(health.claudeProjectsDirectory)}</span></div>` : ''}
  ${health ? `<div class="ch-note">该项目目录编码后为：<span class="ch-mono">${esc(encodeProjectPath(state.context.project?.path ?? ''))}</span></div>` : ''}
  <div class="ch-note" style="margin-top:10px;color:${c.faint}">
    可能原因：项目里还没有跑过 Claude Code 会话；或者 Claude Code 的配置目录不在默认位置（可用 <span class="ch-mono">home</span> 参数指定）。
  </div>
</div>`;
  }

  /* ── session view ─────────────────────────────────────────────────────── */

  function kpi(label: string, value: string, note: string, color: string, c: Palette): string {
    return `
<div class="ch-card" style="background:${c.surface};border-color:${c.border}">
  <div class="ch-kpi-value" style="color:${color}">${esc(value)}</div>
  <div class="ch-kpi-label" style="color:${c.muted}">${esc(label)}</div>
  <div class="ch-kpi-note" style="color:${c.faint}">${note}</div>
</div>`;
  }

  function renderSession(c: Palette, summary: SessionSummary): string {
    const t = summary.totals;
    if (t.turns === 0) {
      return `
${renderWarnings(c, summary.warnings)}
<div class="ch-empty" style="color:${c.muted}">
  <div style="color:${c.text};margin-bottom:8px">该 transcript 里没有可计量的 assistant usage</div>
  <div class="ch-note">共 ${fmtFull(summary.counts.lines)} 行，其中 ${fmtFull(summary.counts.usageRows)} 行带 usage；
  子 agent ${fmtFull(summary.counts.sidechainRows)} 行、全零 usage ${fmtFull(summary.counts.zeroUsageRows)} 行、重复 ${fmtFull(summary.counts.duplicateRows)} 行已按口径排除。</div>
</div>`;
    }

    const rateColor = t.hitRate === null ? c.muted : t.hitRate >= 0.8 ? c.good : t.hitRate >= 0.4 ? c.warn : c.bad;
    const lostTokens = summary.breaks.reduce((sum, b) => sum + b.lostCachedTokens, 0);
    const extraCost = summary.breaks.reduce<number | null>((sum, b) => (b.extraCostUSD === null ? sum : (sum ?? 0) + b.extraCostUSD), null);

    return `
${renderWarnings(c, summary.warnings)}

<div class="ch-grid ch-grid-6">
  ${kpi('加权命中率', fmtRate(t.hitRate), `按 token 加权（${fmtFull(t.turns)} 轮）`, rateColor, c)}
  ${kpi(
    '输出速率',
    `${fmtTokPerSec(summary.outputTokensPerSecond)} tok/s`,
    esc(rateBasisNote(summary.rateBasis)),
    summary.rateBasis === 'api-duration' ? c.good : c.muted,
    c,
  )}
  ${kpi('缓存命中 Token', fmtCompact(t.cacheRead), `占 prompt 的 ${fmtRate(t.hitRate)}`, c.accent, c)}
  ${kpi('缓存写入 Token', fmtCompact(t.cacheCreation), '5m/1h ephemeral 写入', c.info, c)}
  ${kpi('新 Token', fmtCompact(t.newTokens), '未缓存输入 + 输出', c.text, c)}
  ${kpi('估算成本', fmtUSD(t.cost.actualUSD), t.cost.actualUSD === null ? '该模型无公开定价' : `无缓存需 ${fmtUSD(t.cost.noCacheUSD)}`, c.text, c)}
  ${kpi(
    '净节省',
    fmtUSD(t.cost.savedUSD),
    t.cost.savedUSD !== null && t.cost.savedUSD < 0 ? '写入成本高于读命中收益' : '相对完全不用缓存',
    t.cost.savedUSD !== null && t.cost.savedUSD >= 0 ? c.good : c.bad,
    c,
  )}
</div>

<div class="ch-grid ch-grid-2">
  <div class="ch-card" style="background:${c.surface};border-color:${c.border}">
    <div class="ch-kpi-label" style="color:${c.muted};margin-top:0">Prompt 构成</div>
    ${renderStackBar(c, t)}
    <div class="ch-kv" style="color:${c.muted};margin-top:12px">
      <span>prompt 总量</span><span class="ch-num" style="color:${c.text}">${fmtFull(t.promptTokens)}</span>
      <span>未缓存输入</span><span class="ch-num" style="color:${c.text}">${fmtFull(t.input)}</span>
      <span>缓存读命中</span><span class="ch-num" style="color:${c.accent}">${fmtFull(t.cacheRead)}</span>
      <span>缓存写入</span><span class="ch-num" style="color:${c.info}">${fmtFull(t.cacheCreation)}</span>
      <span>输出</span><span class="ch-num" style="color:${c.text}">${fmtFull(t.output)}</span>
    </div>
  </div>
  <div class="ch-card" style="background:${c.surface};border-color:${c.border}">
    <div class="ch-kpi-label" style="color:${c.muted};margin-top:0">会话元数据</div>
    <div class="ch-kv" style="color:${c.muted};margin-top:12px">
      <span>transcript</span><span class="ch-mono" style="color:${c.text};word-break:break-all">${esc(summary.transcript.file)}</span>
      <span>会话 id</span><span class="ch-mono" style="color:${c.text}">${esc(summary.sessionId)}</span>
      <span>时间范围</span><span class="ch-num" style="color:${c.text}">${fmtRange(summary.startedAt, summary.endedAt)}</span>
      <span>average 单轮命中率</span><span class="ch-num" style="color:${c.text}">${fmtRate(t.meanTurnHitRate)}</span>
      <span>文件大小</span><span class="ch-num" style="color:${c.text}">${fmtBytes(summary.transcript.size)}</span>
      <span>断裂次数</span><span class="ch-num" style="color:${summary.breaks.length ? c.bad : c.good}">${fmtFull(summary.breaks.length)}</span>
      <span>断裂丢失缓存</span><span class="ch-num" style="color:${c.text}">${fmtFull(lostTokens)} tokens</span>
      <span>断裂额外成本</span><span class="ch-num" style="color:${c.text}">${fmtUSD(extraCost)}</span>
      ${
        summary.runtime.present
          ? `
      <span>API 累计耗时</span><span class="ch-num" style="color:${c.text}">${fmtGap(summary.runtime.totalAPIDurationMs)}</span>
      <span>工具累计耗时</span><span class="ch-num" style="color:${c.text}">${fmtGap(summary.runtime.totalToolDurationMs)}</span>
      <span>会话总跨度</span><span class="ch-num" style="color:${c.text}">${fmtGap(summary.runtime.totalDurationMs)}</span>
      <span>运行时累计命中率</span><span class="ch-num" style="color:${c.text}">${fmtRate(summary.runtime.hitRate)}</span>
      <span>运行时累计成本</span><span class="ch-num" style="color:${c.text}">${fmtUSD(summary.runtime.totalCostUSD)}</span>
      <span>cost-state 检查点</span><span class="ch-num" style="color:${c.muted}">${fmtFull(summary.runtime.snapshots)} 个</span>
      `
          : `
      <span>运行时遥测</span><span class="ch-num" style="color:${c.muted}">该 transcript 无 cost-state 检查点</span>
      `
      }
    </div>
    <div class="ch-note" style="color:${c.faint};margin-top:8px">
      未标「运行时」的行都是本页自己按主线程逐轮提取的；标「运行时」的那几行来自 Claude Code 写进 transcript 的 cost-state 检查点，
      是会话进程的累计计费视角（含子 agent 等全部模型），两者范围不同，数字不要求相等。
    </div>
  </div>
</div>

<div class="ch-section" style="background:${c.surface};border-color:${c.border}">
  <div class="ch-section-head" style="border-color:${c.border};background:${c.surfaceAlt};color:${c.muted}">
    <span>逐轮命中率</span>
    <span style="color:${c.faint};font-weight:400">
      加权 ${fmtRate(t.hitRate)} · 平均 ${fmtRate(t.meanTurnHitRate)} — 加权口径是"账单视角"：所有被计费的 prompt token 里有多少来自缓存
    </span>
  </div>
  <div class="ch-section-body">${renderTurnChart(summary.turns, summary.breaks, c, 900)}</div>
</div>

${renderBreaks(c, summary.breaks)}
${renderModels(c, summary.models, t)}
${renderCounts(c, summary)}
${renderMethodology(c)}`;
  }

  function renderStackBar(c: Palette, t: SessionSummary['totals']): string {
    const total = Math.max(1, t.promptTokens);
    const segments: Array<[number, string, string]> = [
      [t.cacheRead, c.accent, '缓存读命中'],
      [t.cacheCreation, c.info, '缓存写入'],
      [t.input, c.warn, '未缓存输入'],
    ];
    const bars = segments
      .filter(([value]) => value > 0)
      .map(
        ([value, color, label]) =>
          `<div style="width:${((value / total) * 100).toFixed(2)}%;background:${color}" title="${esc(label)} ${fmtFull(value)}"></div>`,
      )
      .join('');
    const legend = segments
      .map(
        ([value, color, label]) =>
          `<span class="ch-chip" style="border-color:${c.border};color:${c.muted}"><span class="ch-dot" style="background:${color}"></span>${esc(label)} ${fmtRate(value / total)}</span>`,
      )
      .join('');
    return `
<div style="display:flex;height:10px;border-radius:5px;overflow:hidden;background:${c.surfaceAlt};margin-top:12px">${bars}</div>
<div class="ch-row" style="gap:6px;margin-top:10px">${legend}</div>`;
  }

  function renderBreaks(c: Palette, breaks: CacheBreak[]): string {
    if (breaks.length === 0) {
      return `
<div class="ch-section" style="background:${c.surface};border-color:${c.border}">
  <div class="ch-section-head" style="border-color:${c.border};background:${c.surfaceAlt};color:${c.muted}">
    <span>缓存断裂</span><span class="ch-chip" style="border-color:${c.border};color:${c.good}">未检测到</span>
  </div>
  <div class="ch-section-body ch-note" style="color:${c.muted}">
    判定条件与 cc-haha 一致：命中量相对上一轮下降超过 5% 且绝对下降 ≥ 2000 tokens，同时排除 haiku 模型与压缩（compact/microcompact）边界。
  </div>
</div>`;
    }

    const rows = breaks
      .slice()
      .reverse()
      .map((b) => {
        const color = causeColor(b.cause, c);
        return `
<tr>
  <td class="ch-num" style="color:${c.muted}">#${b.turnIndex + 1}</td>
  <td class="ch-num" style="color:${c.muted}">${fmtStamped(b.timestamp)}</td>
  <td>
    <span class="ch-chip" style="border-color:${color};color:${color}">${esc(causeLabel(b.cause))}</span>
  </td>
  <td class="ch-num" style="color:${c.text}">${fmtCompact(b.previousCacheRead)} → ${fmtCompact(b.cacheRead)}</td>
  <td class="ch-num" style="color:${c.bad}">-${fmtCompact(b.lostCachedTokens)}</td>
  <td class="ch-num" style="color:${c.muted}">${fmtGap(b.gapMs)}</td>
  <td class="ch-num" style="color:${c.text}">${fmtUSD(b.extraCostUSD)}</td>
  <td>
    <div class="ch-break-detail" style="color:${c.muted}">${esc(b.detail)}</div>
    <div class="ch-note ch-mono" style="color:${c.faint};margin-top:3px">
      上一轮 ${fmtFull(b.previousPromptTokens)} → 本轮 ${fmtFull(b.promptTokens)} prompt tokens（${b.promptDelta >= 0 ? '+' : ''}${fmtFull(b.promptDelta)}），前缀匹配率 ${fmtRate(b.prefixMatchRatio)}，源码行 ${b.line}
    </div>
  </td>
</tr>`;
      })
      .join('');

    const lostTotal = breaks.reduce((sum, b) => sum + b.lostCachedTokens, 0);
    return `
<div class="ch-section" style="background:${c.surface};border-color:${c.border}">
  <div class="ch-section-head" style="border-color:${c.border};background:${c.surfaceAlt};color:${c.muted}">
    <span>缓存断裂（${breaks.length}）</span>
    <span style="color:${c.faint};font-weight:400">累计丢失缓存前缀 ${fmtFull(lostTotal)} tokens</span>
  </div>
  <div class="ch-section-body ch-scroll">
    <table class="ch-table">
      <thead><tr style="color:${c.muted}">
        <th class="ch-num">轮次</th><th class="ch-num">时间</th><th>归因</th><th class="ch-num">命中读</th><th class="ch-num">丢失</th><th class="ch-num">间隔</th><th class="ch-num">额外成本</th><th>说明</th>
      </tr></thead>
      <tbody style="color:${c.text}">${rows}</tbody>
    </table>
  </div>
</div>`;
  }

  function modelRows(c: Palette, models: SessionSummary['models']): string {
    return models
      .map(
        (m) => `
<tr>
  <td class="ch-mono">${esc(m.model)}${m.priced ? '' : ` <span class="ch-chip" style="border-color:${c.warn};color:${c.warn}">无定价</span>`}</td>
  <td class="ch-num">${fmtFull(m.turns)}</td>
  <td class="ch-num">${fmtCompact(m.promptTokens)}</td>
  <td class="ch-num" style="color:${c.accent}">${fmtRate(m.hitRate)}</td>
  <td class="ch-num">${fmtCompact(m.cacheCreation)}</td>
  <td class="ch-num">${fmtCompact(m.newTokens)}</td>
  <td class="ch-num">${fmtUSD(m.cost.actualUSD)}</td>
  <td class="ch-num" style="color:${m.cost.savedUSD !== null && m.cost.savedUSD >= 0 ? c.good : c.bad}">${fmtUSD(m.cost.savedUSD)}</td>
</tr>`,
      )
      .join('');
  }

  function renderModels(c: Palette, models: SessionSummary['models'], totals: SessionSummary['totals']): string {
    if (models.length === 0) return '';
    return `
<div class="ch-section" style="background:${c.surface};border-color:${c.border}">
  <div class="ch-section-head" style="border-color:${c.border};background:${c.surfaceAlt};color:${c.muted}">
    <span>按模型</span><span style="color:${c.faint};font-weight:400">无公开定价的模型不参与成本合计（cc-haha 口径）</span>
  </div>
  <div class="ch-section-body ch-scroll">
    <table class="ch-table">
      <thead><tr style="color:${c.muted}">
        <th>模型</th><th class="ch-num">轮次</th><th class="ch-num">prompt</th><th class="ch-num">命中率</th><th class="ch-num">写缓存</th><th class="ch-num">新 Token</th><th class="ch-num">成本</th><th class="ch-num">净节省</th>
      </tr></thead>
      <tbody>
        ${modelRows(c, models)}
        <tr style="color:${c.muted};font-weight:600">
          <td>合计</td>
          <td class="ch-num">${fmtFull(totals.turns)}</td>
          <td class="ch-num">${fmtCompact(totals.promptTokens)}</td>
          <td class="ch-num">${fmtRate(totals.hitRate)}</td>
          <td class="ch-num">${fmtCompact(totals.cacheCreation)}</td>
          <td class="ch-num">${fmtCompact(totals.newTokens)}</td>
          <td class="ch-num">${fmtUSD(totals.cost.actualUSD)}</td>
          <td class="ch-num">${fmtUSD(totals.cost.savedUSD)}</td>
        </tr>
      </tbody>
    </table>
  </div>
</div>`;
  }

  function renderCounts(c: Palette, summary: SessionSummary): string {
    const counts = summary.counts;
    const items: Array<[string, number, string]> = [
      ['总行数', counts.lines, ''],
      ['带 usage 的行', counts.usageRows, ''],
      ['计入的轮次', summary.totals.turns, '去重后的真实 API 调用'],
      ['重复行（已排除）', counts.duplicateRows, '一次回复的每个 content block 各写一行，且重复完整 usage'],
      ['子 agent 行（已排除）', counts.sidechainRows, 'isSidechain: true'],
      ['全零 usage（已跳过）', counts.zeroUsageRows, '<synthetic>：中断 / API 错误 / 无响应'],
      ['fork 继承（已排除）', counts.forkedRows, 'forkedFrom 标记'],
      ['无法解析的行', counts.malformedLines, '会话正在写入时读到半行属正常'],
    ];
    return `
<div class="ch-section" style="background:${c.surface};border-color:${c.border}">
  <div class="ch-section-head" style="border-color:${c.border};background:${c.surfaceAlt};color:${c.muted}">
    <span>解析明细</span><span style="color:${c.faint};font-weight:400">每一行被计入或排除的原因</span>
  </div>
  <div class="ch-section-body">
    <div class="ch-kv3">
      ${items
        .map(
          ([label, value, note]) =>
            `<span style="color:${c.muted}">${esc(label)}</span>` +
            // The value gets its own track so all of them form one aligned column;
            // the note gets a third track instead of trailing the value inside a
            // right-aligned cell, which pushed each value left by its note's width.
            `<span class="ch-num" style="color:${c.text}">${fmtFull(value)}</span>` +
            `<span class="ch-note" style="color:${c.faint}">${note ? esc(note) : ''}</span>`,
        )
        .join('')}
    </div>
  </div>
</div>`;
  }

  function renderWarnings(c: Palette, warnings: string[]): string {
    if (warnings.length === 0) return '';
    return `
<div class="ch-section" style="background:${c.surface};border-color:${c.warn}">
  <div class="ch-section-head" style="border-color:${c.border};background:${c.surfaceAlt};color:${c.warn}">
    <span>口径提示</span>
  </div>
  <div class="ch-section-body">
    ${warnings.map((w) => `<div class="ch-warn" style="color:${c.muted}"><span style="color:${c.warn}">•</span><span>${esc(w)}</span></div>`).join('')}
  </div>
</div>`;
  }

  function renderMethodology(c: Palette): string {
    return `
<div class="ch-section" style="background:${c.surface};border-color:${c.border}">
  <div class="ch-section-body">
    <details class="ch-details">
      <summary style="color:${c.muted}">计算口径（移植自 cc-haha）与已知边界</summary>
      <div class="ch-note" style="color:${c.muted}">
        <div style="margin-bottom:8px"><strong style="color:${c.text}">命中率</strong><br/>
        <span class="ch-mono">hitRate = cacheRead / (input + cacheRead + cacheCreation)</span><br/>
        四个桶互斥，<span class="ch-mono">input</span> 不含缓存 token，因此三者之和才是一次请求的 prompt 总量。分母用错会系统性高估命中率。</div>

        <div style="margin-bottom:8px"><strong style="color:${c.text}">去重</strong><br/>
        一次 assistant 回复的每个 content block 各写一行 JSONL，且每行重复完整的 usage 对象。按 <span class="ch-mono">message.id + requestId</span> 去重；逐行求和会把真实用量放大约 2.2 倍。</div>

        <div style="margin-bottom:8px"><strong style="color:${c.text}">排除项</strong><br/>
        <span class="ch-mono">isSidechain</span>（子 agent 统计的是子 agent 自己的上下文）、全零 usage（<span class="ch-mono">&lt;synthetic&gt;</span>）、<span class="ch-mono">forkedFrom</span>（fork 复制的行属于源会话）。</div>

        <div style="margin-bottom:8px"><strong style="color:${c.text}">加权 vs 平均</strong><br/>
        会话级"加权命中率"= ΣcacheRead / Σprompt，是账单视角；"平均单轮命中率"是各轮命中率的算术平均。长会话里缓存前缀每轮都会被重放，两者必然不同，不要混用。</div>

        <div style="margin-bottom:8px"><strong style="color:${c.text}">断裂判定</strong><br/>
        与 cc-haha 相同：<span class="ch-mono">cacheRead &lt; prev × 0.95</span> 且绝对下降 ≥ 2000 tokens。haiku 系列跳过（缓存行为不同，判定会产生假阳性）；压缩（<span class="ch-mono">compact_boundary</span> / <span class="ch-mono">microcompact_boundary</span>）后的下降视为预期。</div>

        <div style="margin-bottom:8px"><strong style="color:${c.text}">断裂归因的边界</strong><br/>
        cc-haha 在请求前对 system prompt 与工具 schema 做哈希，因此能指出"哪个工具的描述变了"。插件看不到出站请求，只能用 transcript 能证明的证据：命中量 ≈ 服务端实际复用的前缀长度（据此可定位前缀在何处断开）、时间差（5 分钟 / 1 小时 TTL）、模型是否切换、prompt 是否明显变化。<strong style="color:${c.text}">"前缀变化"与"疑似服务端"的区分是启发式的</strong>——cc-haha 对"prompt 未变且间隔 &lt; 5 分钟"的同类情形也给出"大概率服务端路由/驱逐"的结论，并非确定性判断。</div>

        <div><strong style="color:${c.text}">成本</strong><br/>
        用 Claude 公开价目表（与 cc-haha <span class="ch-mono">modelCost.ts</span> 一致）。没有公开定价的模型返回 <span class="ch-mono">null</span> 并从合计中排除，而不是按 Claude 价格硬算——那是 cc-haha 明确拒绝做的事。净节省 = 无缓存成本 − 实际成本，为负说明缓存写入的开销超过了读命中的收益。</div>
      </div>
    </details>
  </div>
</div>`;
  }

  /* ── overview view ────────────────────────────────────────────────────── */

  function renderOverview(c: Palette, o: OverviewResponse): string {
    if (o.sessions === 0) {
      return `
${renderWarnings(c, o.warnings)}
<div class="ch-empty" style="color:${c.muted}">
  <div style="color:${c.text};margin-bottom:8px">没有可汇总的会话</div>
  <div class="ch-note">已扫描 ${fmtFull(o.projectsScanned)} 个项目的 transcript 目录，跳过 ${fmtFull(o.skippedSessions)} 个。</div>
</div>`;
    }

    const t = o.totals;
    const dayRows = o.days
      .slice(0, 30)
      .map(
        (d) => `
<tr>
  <td class="ch-mono">${esc(d.date)}</td>
  <td class="ch-num">${fmtFull(d.sessions)}</td>
  <td class="ch-num">${fmtCompact(d.promptTokens)}</td>
  <td class="ch-num" style="color:${c.accent}">${fmtRate(d.hitRate)}</td>
  <td class="ch-num">${fmtCompact(d.cacheCreation)}</td>
  <td class="ch-num">${fmtCompact(d.newTokens)}</td>
  <td class="ch-num">${fmtUSD(d.cost.actualUSD)}</td>
  <td class="ch-num" style="color:${d.cost.savedUSD !== null && d.cost.savedUSD >= 0 ? c.good : c.bad}">${fmtUSD(d.cost.savedUSD)}</td>
</tr>`,
      )
      .join('');

    const sessionRows = o.topBreakSessions
      .map(
        (s) => `
<tr>
  <td class="ch-mono">${esc(s.sessionId.slice(0, 8))}</td>
  <td class="ch-mono" style="word-break:break-all">${esc(s.projectPath)}</td>
  <td class="ch-num" style="color:${c.bad}">${fmtFull(s.breaks)}</td>
  <td class="ch-num">${fmtFull(s.lostCachedTokens)}</td>
  <td class="ch-num">${fmtRate(s.hitRate)}</td>
</tr>`,
      )
      .join('');

    return `
${renderWarnings(c, o.warnings)}
<div class="ch-grid ch-grid-6">
  ${kpi('总体加权命中率', fmtRate(t.hitRate), `${fmtFull(o.sessions)} 个会话 / ${fmtFull(t.turns)} 轮`, t.hitRate !== null && t.hitRate >= 0.6 ? c.good : c.warn, c)}
  ${kpi('缓存命中 Token', fmtCompact(t.cacheRead), '', c.accent, c)}
  ${kpi('缓存写入 Token', fmtCompact(t.cacheCreation), '', c.info, c)}
  ${kpi('新 Token', fmtCompact(t.newTokens), '未缓存输入 + 输出', c.text, c)}
  ${kpi('估算成本', fmtUSD(t.cost.actualUSD), `无缓存需 ${fmtUSD(t.cost.noCacheUSD)}`, c.text, c)}
  ${kpi('净节省', fmtUSD(t.cost.savedUSD), '相对完全不用缓存', t.cost.savedUSD !== null && t.cost.savedUSD >= 0 ? c.good : c.bad, c)}
</div>

<div class="ch-section" style="background:${c.surface};border-color:${c.border}">
  <div class="ch-section-head" style="border-color:${c.border};background:${c.surfaceAlt};color:${c.muted}">
    <span>按日</span><span style="color:${c.faint};font-weight:400">${o.scope === 'all' ? '全部项目' : '当前项目'} · 扫描 ${fmtFull(o.projectsScanned)} 个项目目录</span>
  </div>
  <div class="ch-section-body ch-scroll">
    <table class="ch-table">
      <thead><tr style="color:${c.muted}">
        <th>日期</th><th class="ch-num">会话</th><th class="ch-num">prompt</th><th class="ch-num">命中率</th><th class="ch-num">写缓存</th><th class="ch-num">新 Token</th><th class="ch-num">成本</th><th class="ch-num">净节省</th>
      </tr></thead>
      <tbody style="color:${c.text}">${dayRows}</tbody>
    </table>
  </div>
</div>

${
  o.topBreakSessions.length > 0
    ? `<div class="ch-section" style="background:${c.surface};border-color:${c.border}">
  <div class="ch-section-head" style="border-color:${c.border};background:${c.surfaceAlt};color:${c.muted}">
    <span>断裂最多的会话</span><span style="color:${c.faint};font-weight:400">按丢失的缓存前缀排序</span>
  </div>
  <div class="ch-section-body ch-scroll">
    <table class="ch-table">
      <thead><tr style="color:${c.muted}"><th>会话</th><th>项目</th><th class="ch-num">断裂</th><th class="ch-num">丢失 tokens</th><th class="ch-num">命中率</th></tr></thead>
      <tbody style="color:${c.text}">${sessionRows}</tbody>
    </table>
  </div>
</div>`
    : ''
}

${renderModels(c, o.models, t)}
${o.breaks.length > 0 ? renderBreaks(c, o.breaks) : ''}
${renderMethodology(c)}`;
  }

  /* ── events ───────────────────────────────────────────────────────────── */

  function wire(): void {
    const refreshButton = root.querySelector('#ch-refresh');
    if (refreshButton) refreshButton.addEventListener('click', () => void refresh(true));

    const autoButton = root.querySelector('#ch-auto');
    if (autoButton) {
      autoButton.addEventListener('click', () => {
        state.autoRefresh = !state.autoRefresh;
        setupTimer();
        render();
      });
    }

    for (const button of Array.from(root.querySelectorAll('[data-scope]'))) {
      button.addEventListener('click', () => {
        const scope = button.getAttribute('data-scope') as ViewState['scope'];
        if (scope === state.scope) return;
        state.scope = scope;
        state.error = null;
        void refresh(false);
      });
    }

    const select = root.querySelector('#ch-session') as HTMLSelectElement | null;
    if (select) {
      select.addEventListener('change', () => {
        state.sessionId = select.value;
        void refresh(false);
      });
    }

    const allToggle = root.querySelector('#ch-all') as HTMLInputElement | null;
    if (allToggle) {
      allToggle.addEventListener('change', () => {
        state.overviewAll = allToggle.checked;
        void refresh(false);
      });
    }
  }

  function setupTimer(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (!state.autoRefresh) return;
    timer = setInterval(() => {
      // A hidden tab does not need to re-read transcripts; polling in the
      // background wastes the host's I/O for a panel nobody is looking at.
      if (document.visibilityState !== 'visible') return;
      void refresh(false);
    }, AUTO_REFRESH_MS);
  }

  const unsubscribe = api.onContextChange((ctx) => {
    const nextProjectPath = ctx.project?.path ?? null;
    const nextAppSessionId = ctx.session?.id ?? null;
    const projectChanged = nextProjectPath !== state.contextProjectPath;
    const sessionChanged = nextAppSessionId !== state.contextAppSessionId;

    state.context = ctx;
    state.contextProjectPath = nextProjectPath;
    state.contextAppSessionId = nextAppSessionId;

    if (projectChanged) {
      // A different project means a different transcript directory; the previous
      // session selection and its analysis are meaningless now.
      state.sessionId = null;
      state.summary = null;
      state.overview = null;
    }
    render();
    // A bare theme flip repaints and stops there — re-reading transcripts for a
    // colour change would waste the host's I/O.
    if (projectChanged || sessionChanged) void refresh(false);
  });

  // `mount` runs on every activation of the tab, so a previous mount of the same
  // element may still hold state; store cleanup on the container the host reuses.
  const holder = container as unknown as { _cacheHitCleanup?: () => void };
  holder._cacheHitCleanup = () => {
    disposed = true;
    unsubscribe();
    if (timer) clearInterval(timer);
    timer = null;
  };

  render();
  void refresh(false);
  setupTimer();
}

export function unmount(container: HTMLElement): void {
  const holder = container as unknown as { _cacheHitCleanup?: () => void };
  if (typeof holder._cacheHitCleanup === 'function') {
    holder._cacheHitCleanup();
    delete holder._cacheHitCleanup;
  }
  container.innerHTML = '';
}
