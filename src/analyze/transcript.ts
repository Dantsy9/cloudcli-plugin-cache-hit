/**
 * Transcript discovery and parsing.
 *
 * Claude Code writes one JSONL transcript per session to:
 *
 *     $HOME/.claude/projects/<encoded-project-path>/<session-id>.jsonl
 *
 * The encoding is Claude Code's own: every character outside `[A-Za-z0-9-]`
 * becomes `-`. CloudCLI's host uses the identical rule
 * (`server/modules/providers/services/provider-token-usage.service.ts:451`), so
 * the two agree on which directory belongs to which project.
 *
 * A plugin cannot see the host's database, and `api.context.session.id` is the
 * host's *app* session id rather than the transcript id, so the transcript is
 * located by project directory instead. See `resolveSessionFile()`.
 */

import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { SessionListItem } from '../types.js';
import { isRecord } from './usage.js';

/**
 * Transcripts grow to tens of megabytes on long sessions. Reading the whole file
 * every poll is wasteful, so anything larger than this is analysed from its tail
 * and flagged as truncated. CloudCLI's own reader tail-reads for the same reason.
 */
export const MAX_TRANSCRIPT_BYTES = 48 * 1024 * 1024;

/** A session whose file changed within this window is shown as "active". */
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

export class TranscriptError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'TranscriptError';
  }
}

/**
 * The plugin server only receives PATH / HOME / NODE_ENV / PLUGIN_NAME (plus a
 * few Windows essentials), and `HOME` is unset on Windows — so the fallback is
 * load-bearing, not defensive noise.
 */
export function resolveHome(override?: string): string {
  if (override && override.trim()) {
    const resolved = path.resolve(override.trim());
    if (!path.isAbsolute(resolved)) {
      throw new TranscriptError('home 参数必须是绝对路径', 'INVALID_HOME');
    }
    return resolved;
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    throw new TranscriptError(
      '无法确定用户主目录：HOME 与 USERPROFILE 都未设置',
      'HOME_UNRESOLVED',
      'CloudCLI 启动插件子进程时只透传有限的环境变量；可在请求里显式传 home 参数。',
    );
  }
  return path.resolve(home);
}

export function claudeProjectsRoot(home: string): string {
  return path.join(home, '.claude', 'projects');
}

/** Claude Code's project-directory encoding. Mirrors the CloudCLI host exactly. */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
}

/** Reject any path that escapes `base` after resolution. */
function assertInside(base: string, target: string): void {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TranscriptError('解析出的路径越界，已拒绝', 'PATH_ESCAPE');
  }
}

/**
 * The directory holding a project's transcripts. Both `home` and `projectPath`
 * are validated; the result is guaranteed to sit under `<home>/.claude/projects`.
 */
export function projectTranscriptDirectory(home: string, projectPath: string): string {
  if (!projectPath || !path.isAbsolute(projectPath)) {
    throw new TranscriptError('projectPath 必须是绝对路径', 'INVALID_PROJECT_PATH');
  }
  const root = claudeProjectsRoot(home);
  const directory = path.join(root, encodeProjectPath(path.resolve(projectPath)));
  assertInside(root, directory);
  return directory;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function listProjectDirectories(home: string): Promise<string[]> {
  const root = claudeProjectsRoot(home);
  if (!(await isDirectory(root))) return [];
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/* ── Reading ─────────────────────────────────────────────────────────────── */

export interface ReadResult {
  text: string;
  /** True when only the tail was read because the file exceeded the cap. */
  truncated: boolean;
  size: number;
  /** Bytes skipped from the front when truncated. */
  skippedBytes: number;
}

export async function readTranscript(file: string): Promise<ReadResult> {
  const stats = await fsp.stat(file);
  const size = stats.size;

  if (size <= MAX_TRANSCRIPT_BYTES) {
    return { text: await fsp.readFile(file, 'utf8'), truncated: false, size, skippedBytes: 0 };
  }

  const start = size - MAX_TRANSCRIPT_BYTES;
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(MAX_TRANSCRIPT_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_TRANSCRIPT_BYTES, start);
    return {
      // The first partial line is dropped below when parsing.
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: true,
      size,
      skippedBytes: start,
    };
  } finally {
    await handle.close();
  }
}

export interface ParsedLine {
  line: number;
  record: Record<string, unknown>;
}

export interface ParsedTranscript {
  lines: ParsedLine[];
  totalLines: number;
  malformed: number;
}

/**
 * Parse one JSONL transcript.
 *
 * Malformed lines are counted, never thrown on: a live session is being appended
 * to while we read it, so the final line is routinely half-written. CloudCLI's
 * own reader swallows the same case.
 */
export function parseTranscript(text: string, skipFirstPartialLine: boolean): ParsedTranscript {
  const rawLines = text.split('\n');
  const lines: ParsedLine[] = [];
  let malformed = 0;
  let total = 0;

  for (let i = 0; i < rawLines.length; i += 1) {
    // A tail read starts mid-line; that fragment is not a real record.
    if (skipFirstPartialLine && i === 0) continue;
    const raw = rawLines[i]!;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    total += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    if (!isRecord(parsed)) {
      malformed += 1;
      continue;
    }
    lines.push({ line: i + 1, record: parsed });
  }

  return { lines, totalLines: total, malformed };
}

/* ── Session listing ─────────────────────────────────────────────────────── */

export function isTranscriptFile(name: string): boolean {
  return name.endsWith('.jsonl');
}

/**
 * List a project's transcripts, newest first.
 *
 * `turns` is intentionally left null: computing it needs a full parse of every
 * file, and the dropdown only needs to identify a session. The selected session
 * gets the full analysis.
 */
export async function listSessions(directory: string): Promise<SessionListItem[]> {
  if (!(await isDirectory(directory))) return [];
  const now = Date.now();
  const items: SessionListItem[] = [];

  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isFile() || !isTranscriptFile(entry.name)) continue;
    const file = path.join(directory, entry.name);
    try {
      const stats = await fsp.stat(file);
      items.push({
        sessionId: entry.name.replace(/\.jsonl$/, ''),
        file,
        size: stats.size,
        mtime: stats.mtimeMs,
        active: now - stats.mtimeMs <= ACTIVE_WINDOW_MS,
        startedAt: null,
        turns: null,
      });
    } catch {
      // Raced delete — skip.
    }
  }

  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}

/**
 * Locate the transcript to analyse.
 *
 * `sessionId` may be a transcript id (the .jsonl basename). When omitted, or when
 * it matches nothing, the most recently modified transcript is used — for a
 * session that is currently running, that is the active one. The caller is told
 * which file won so the UI can show it rather than silently analysing a
 * different session than the user expected.
 */
export async function resolveSessionFile(
  directory: string,
  sessionId?: string | null,
): Promise<{ file: string; sessionId: string; fellBack: boolean }> {
  const wanted = sessionId?.trim();
  if (wanted && /^[A-Za-z0-9._-]+$/.test(wanted)) {
    const candidate = path.join(directory, `${wanted}.jsonl`);
    assertInside(directory, candidate);
    if (await pathExists(candidate)) {
      return { file: candidate, sessionId: wanted, fellBack: false };
    }
  }

  const sessions = await listSessions(directory);
  const newest = sessions[0];
  if (!newest) {
    throw new TranscriptError(
      '该项目目录下没有任何 .jsonl transcript',
      'NO_TRANSCRIPTS',
      `已查找：${directory}。若 Claude Code 的配置目录不在默认位置，请通过 home 参数指定。`,
    );
  }
  return { file: newest.file, sessionId: newest.sessionId, fellBack: Boolean(wanted) };
}

export function defaultHomeForDisplay(): string {
  return os.homedir();
}
