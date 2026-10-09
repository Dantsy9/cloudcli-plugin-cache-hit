/**
 * Plugin backend server.
 *
 * Host contract (docs: "Backend Servers"):
 *   - listen on port 0, bound to 127.0.0.1 only
 *   - print exactly one JSON line `{"ready":true,"port":<n>}` to stdout within 10s
 *   - handle SIGTERM and exit within 5s (then SIGKILL)
 *   - the host proxies `/api/plugins/cache-hit/rpc/*` here, adding auth and
 *     `x-plugin-secret-*` headers; browser cookies and tokens are never forwarded
 *
 * Because the host parses stdout for the ready line, every diagnostic in this
 * process goes to stderr via `console.error`. Nothing else may touch stdout.
 */

import http from 'node:http';

import type {
  ApiError,
  HealthResponse,
  OverviewResponse,
  SessionListResponse,
  SessionSummary,
  StatusResponse,
} from './types.js';
import { buildOverview, cacheEntryCount, clearAnalysisCache, summarizeSessionFile } from './analyze/summarize.js';
import { formatCacheHitRate, formatCompactTokens } from './analyze/metrics.js';
import {
  claudeProjectsRoot,
  listProjectDirectories,
  listSessions,
  projectTranscriptDirectory,
  resolveHome,
  resolveSessionFile,
  TranscriptError,
} from './analyze/transcript.js';

const PLUGIN_NAME = process.env.PLUGIN_NAME || 'cache-hit';
const STARTED_AT = Date.now();

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    const body: ApiError = { error: error.message, code: error.code };
    if (error.hint) body.hint = error.hint;
    sendJson(res, error.status, body);
    return;
  }
  if (error instanceof TranscriptError) {
    const body: ApiError = { error: error.message, code: error.code };
    if (error.hint) body.hint = error.hint;
    sendJson(res, 400, body);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${PLUGIN_NAME}] request failed:`, error);
  sendJson(res, 500, { error: message, code: 'INTERNAL_ERROR' } satisfies ApiError);
}

/** `home` is honoured so the plugin can read a non-default Claude config root. */
function homeFrom(params: URLSearchParams): string {
  return resolveHome(params.get('home') ?? undefined);
}

function projectPathFrom(params: URLSearchParams, required: true): string;
function projectPathFrom(params: URLSearchParams, required: false): string | null;
function projectPathFrom(params: URLSearchParams, required: boolean): string | null {
  const raw = params.get('projectPath');
  if (!raw || !raw.trim()) {
    if (required) {
      throw new HttpError(
        400,
        '缺少 projectPath 参数',
        'MISSING_PROJECT_PATH',
        '正常情况下由插件前端从 api.context.project.path 自动带上。',
      );
    }
    return null;
  }
  return raw.trim();
}

type Handler = (params: URLSearchParams, body: unknown) => Promise<unknown>;

const routes: Record<string, Handler> = {
  async health(params) {
    const home = homeFrom(params);
    const projectsRoot = claudeProjectsRoot(home);
    const directories = await listProjectDirectories(home);
    const response: HealthResponse = {
      ok: true,
      plugin: PLUGIN_NAME,
      node: process.version,
      pid: process.pid,
      home,
      claudeProjectsDirectory: projectsRoot,
      claudeProjectsExists: directories.length > 0,
      projectDirectories: directories.length,
      cacheEntries: cacheEntryCount(),
      startedAt: STARTED_AT,
    };
    return response;
  },

  async projects(params) {
    const home = homeFrom(params);
    const directories = await listProjectDirectories(home);
    return { home, projectsRoot: claudeProjectsRoot(home), directories };
  },

  async sessions(params) {
    const home = homeFrom(params);
    const projectPath = projectPathFrom(params, true);
    const directory = projectTranscriptDirectory(home, projectPath);
    const sessions = await listSessions(directory);
    return {
      projectPath,
      projectDirectory: directory,
      sessions,
      warnings:
        sessions.length === 0
          ? [
              `在 ${directory} 下没有找到 .jsonl transcript。该目录名由项目绝对路径按 Claude Code 的规则编码而来（非 [A-Za-z0-9-] 的字符替换为 -）。`,
            ]
          : [],
    } satisfies SessionListResponse;
  },

  async session(params) {
    const home = homeFrom(params);
    const projectPath = projectPathFrom(params, true);
    const directory = projectTranscriptDirectory(home, projectPath);
    const requested = params.get('sessionId');
    const resolved = await resolveSessionFile(directory, requested);
    const summary: SessionSummary = await summarizeSessionFile({
      file: resolved.file,
      sessionId: resolved.sessionId,
      projectPath,
      force: params.get('force') === '1',
    });
    if (resolved.fellBack && requested) {
      summary.warnings.unshift(
        `未找到会话 ${requested}，已回退到最近修改的会话 ${resolved.sessionId}。注意 api.context.session.id 是 CloudCLI 的 app 会话 id，与 transcript 文件名不同。`,
      );
    }
    return summary;
  },

  async overview(params) {
    const home = homeFrom(params);
    const all = params.get('all') === '1';
    const projectPath = all ? null : projectPathFrom(params, false);
    const response: OverviewResponse = await buildOverview({ home, projectPath });
    return response;
  },

  /**
   * Compact single-session status for a UI chip.
   *
   * Always answers 200 so a poller never has to special-case "no project yet" or
   * "no transcript yet" as an error — `available: false` plus `reason` carries
   * that. Genuine misconfiguration (a relative projectPath) still 400s.
   */
  async status(params) {
    const home = homeFrom(params);
    const projectPath = params.get('projectPath')?.trim() ?? null;
    const base = {
      ok: true as const,
      projectPath,
      updatedAt: Date.now(),
    };

    if (!projectPath) {
      return {
        ...base,
        available: false,
        reason: '未选择项目',
        sessionId: null,
        transcriptFile: null,
        turnCount: 0,
        model: null,
        hitRate: null,
        cacheRead: 0,
        cacheCreation: 0,
        promptTokens: 0,
        newTokens: 0,
        breaks: 0,
        lostCachedTokens: 0,
        actualCostUSD: null,
        savedUSD: null,
        truncated: false,
        chipText: '缓存命中 --',
        detailText: '未选择项目',
      } satisfies StatusResponse;
    }

    const directory = projectTranscriptDirectory(home, projectPath);
    let resolved;
    try {
      resolved = await resolveSessionFile(directory, params.get('sessionId'));
    } catch (error) {
      const reason = error instanceof TranscriptError ? error.message : String(error);
      return {
        ...base,
        available: false,
        reason,
        sessionId: null,
        transcriptFile: null,
        turnCount: 0,
        model: null,
        hitRate: null,
        cacheRead: 0,
        cacheCreation: 0,
        promptTokens: 0,
        newTokens: 0,
        breaks: 0,
        lostCachedTokens: 0,
        actualCostUSD: null,
        savedUSD: null,
        truncated: false,
        chipText: '缓存命中 --',
        detailText: '暂无会话',
      } satisfies StatusResponse;
    }

    const summary = await summarizeSessionFile({
      file: resolved.file,
      sessionId: resolved.sessionId,
      projectPath,
    });
    const t = summary.totals;
    // The dominant model is the one that burned the most prompt tokens — the
    // same ordering `summarizeModels` already sorts by.
    const model = summary.models[0]?.model ?? null;

    return {
      ...base,
      available: t.turns > 0,
      ...(t.turns > 0 ? {} : { reason: 'transcript 里没有可计量的 usage' }),
      sessionId: resolved.sessionId,
      transcriptFile: resolved.file,
      turnCount: t.turns,
      model,
      hitRate: t.hitRate,
      cacheRead: t.cacheRead,
      cacheCreation: t.cacheCreation,
      promptTokens: t.promptTokens,
      newTokens: t.newTokens,
      breaks: summary.breaks.length,
      lostCachedTokens: summary.breaks.reduce((sum, brk) => sum + brk.lostCachedTokens, 0),
      actualCostUSD: t.cost.actualUSD,
      savedUSD: t.cost.savedUSD,
      truncated: summary.transcript.truncated,
      chipText: t.turns > 0 ? `缓存命中 ${formatCacheHitRate(t.hitRate)}` : '缓存命中 --',
      detailText:
        t.turns > 0
          ? `${t.turns} 轮 · 缓存读 ${formatCompactTokens(t.cacheRead)} · 新 ${formatCompactTokens(t.newTokens)}`
          : '暂无用量',
    } satisfies StatusResponse;
  },

  async 'clear-cache'() {
    clearAnalysisCache();
    return { ok: true, cacheEntries: cacheEntryCount() };
  },
};

const server = http.createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const name = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');

      if (!name) {
        sendJson(res, 200, { plugin: PLUGIN_NAME, routes: Object.keys(routes) });
        return;
      }

      const handler = routes[name];
      if (!handler) {
        throw new HttpError(404, `未知路由 /${name}`, 'NOT_FOUND', `可用：${Object.keys(routes).join(', ')}`);
      }
      if (req.method !== 'GET' && req.method !== 'POST') {
        throw new HttpError(405, '仅支持 GET / POST', 'METHOD_NOT_ALLOWED');
      }

      const body = await readBody(req);
      sendJson(res, 200, await handler(url.searchParams, body));
    } catch (error) {
      sendError(res, error);
    }
  })();
});

/** Bodies are unused today; drain them so the socket can be reused cleanly. */
function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

let shuttingDown = false;
process.on('SIGTERM', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // The host allows 5s before SIGKILL; closing the listener is enough.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});

server.on('error', (error) => {
  console.error(`[${PLUGIN_NAME}] server error:`, error);
  process.exit(1);
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') {
    // REQUIRED: the single JSON line the host waits for. Keep stdout clean.
    console.log(JSON.stringify({ ready: true, port: address.port }));
    console.error(`[${PLUGIN_NAME}] listening on 127.0.0.1:${address.port}`);
  }
});
