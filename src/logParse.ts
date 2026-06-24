import { statSync, openSync, readSync, closeSync } from 'fs';
import { envMs } from './env.ts';

const STATUS_TAIL_BYTES = envMs('WORKER_STATUS_TAIL_BYTES', 1_048_576);
const SENTINEL_TAIL_BYTES = envMs('WORKER_SENTINEL_TAIL_BYTES', 65_536);
// Hard ceiling for the json-error full rescan. Without it a multi-MB streaming-json log gets
// read whole into RAM on every cache-missing readSentinel (reaper sweep, per orphan, every 10s).
// 8MB covers errors buried well before EOF; the 1MB tail above already catches terminal errors.
const MAX_ERROR_SCAN_BYTES = envMs('WORKER_MAX_ERROR_SCAN_BYTES', 8_388_608);

export function tailCapped(logPath: string, cap: number = STATUS_TAIL_BYTES): string {
  try {
    const size = statSync(logPath).size;
    if (size === 0) return '';
    const readBytes = Math.min(size, cap);
    const offset = Math.max(0, size - readBytes);
    const fd = openSync(logPath, 'r');
    try {
      const buf = Buffer.allocUnsafe(readBytes);
      readSync(fd, buf, 0, readBytes, offset);
      let text = buf.toString('utf8');
      if (offset > 0) {
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
      }
      return text;
    } finally {
      closeSync(fd);
    }
  } catch { return ''; }
}

export function extractAssistantTexts(line: string): string[] {
  if (line.charCodeAt(0) !== 123 /* { */) return [];
  const obj = tryParse(line);
  if (!obj) return [];
  const out: string[] = [];
  pushDeepText(out, obj);
  if (Array.isArray((obj as { parts?: unknown }).parts)) {
    for (const p of (obj as { parts: unknown[] }).parts) {
      if (p && typeof p === 'object') pushStringField(out, p, 'text');
    }
  }
  const content = (obj as { content?: unknown }).content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === 'object') {
        pushStringField(out, c, 'text');
        const nested = (c as { content?: unknown }).content;
        if (Array.isArray(nested)) {
          for (const n of nested) {
            if (n && typeof n === 'object') pushStringField(out, n, 'text');
          }
        }
      }
    }
  }
  pushStringField(out, obj, 'text');
  pushStringField(out, obj, 'thought');
  pushStringField(out, obj, 'reasoning');
  return out;
}

function pushDeepText(out: string[], obj: Record<string, unknown>): void {
  const item = (obj as { item?: unknown }).item;
  if (item && typeof item === 'object') {
    const t = (item as Record<string, unknown>).text;
    if (typeof t === 'string') out.push(t);
  }
  const msg = (obj as { message?: unknown }).message;
  if (msg && typeof msg === 'object') {
    const m = msg as Record<string, unknown>;
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && typeof part === 'object') pushStringField(out, part, 'text');
      }
    }
  }
}

function tryParse(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

function pushStringField(out: string[], owner: unknown, key: string): void {
  if (!owner || typeof owner !== 'object') return;
  const v = (owner as Record<string, unknown>)[key];
  if (typeof v === 'string' && v.length > 0) out.push(v);
}

type SentinelResult = 'done' | `failed:${string}` | 'failed' | null;

const DONE_RE = /^DONE(\s|$)/;
const FAILED_RE = /^FAILED(:|\s|$)/;
const FAILED_STRIP_RE = /^FAILED:?\s*/;

function matchSentinel(lines: string[]): SentinelResult {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (DONE_RE.test(line)) return 'done';
    if (FAILED_RE.test(line)) {
      const reason = line.replace(FAILED_STRIP_RE, '').trim();
      return reason ? `failed:${reason}` : 'failed';
    }
  }
  return null;
}

type CacheEntry = { size: number; mtimeMs: number; status: SentinelResult; lastText: string; json: boolean };
const _sentinelCache = new Map<string, CacheEntry>();
const SENTINEL_CACHE_MAX = 64;

export function readSentinel(logPath: string, json: boolean): { status: SentinelResult; lastText: string } {
  let st: { size: number; mtimeMs: number };
  try { st = statSync(logPath); } catch { return { status: null, lastText: '' }; }
  if (st.size === 0) return { status: null, lastText: '' };

  const cached = _sentinelCache.get(logPath);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs && cached.json === json) {
    return { status: cached.status, lastText: cached.lastText };
  }

  const suffix = tailCapped(logPath, SENTINEL_TAIL_BYTES);
  const suffixLines = suffix.split('\n').filter(Boolean);
  const suffixCandidates = json ? suffixLines.flatMap(extractAssistantTexts) : suffixLines;
  let status = matchSentinel(suffixCandidates);

  if (!status && json) {
    status = detectJsonError(suffixLines);
  }

  if (!status && st.size > SENTINEL_TAIL_BYTES) {
    const full = tailCapped(logPath, STATUS_TAIL_BYTES);
    const fullLines = full.split('\n').filter(Boolean);
    const fullCandidates = json ? fullLines.flatMap(extractAssistantTexts) : fullLines;
    status = matchSentinel(fullCandidates);
    if (!status && json) status = detectJsonError(fullLines);
    if (status) {
      const lastText = fullCandidates[fullCandidates.length - 1] ?? '';
      cachePut(logPath, st, json, status, lastText);
      return { status, lastText };
    }
  }

  if (!status && json && st.size > STATUS_TAIL_BYTES) {
    const big = tailCapped(logPath, Math.min(st.size, MAX_ERROR_SCAN_BYTES));
    const bigLines = big.split('\n').filter(Boolean);
    status = detectJsonError(bigLines);
  }

  const lastText = suffixCandidates[suffixCandidates.length - 1] ?? '';
  cachePut(logPath, st, json, status, lastText);
  return { status, lastText };
}

function cachePut(logPath: string, st: { size: number; mtimeMs: number }, json: boolean, status: SentinelResult, lastText: string): void {
  if (_sentinelCache.size >= SENTINEL_CACHE_MAX) {
    const first = _sentinelCache.keys().next().value;
    if (first !== undefined) _sentinelCache.delete(first);
  }
  _sentinelCache.set(logPath, { size: st.size, mtimeMs: st.mtimeMs, status, lastText, json });
}

export function __resetSentinelCache(): void { _sentinelCache.clear(); }

function detectJsonError(lines: string[]): SentinelResult {
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = tryParse(lines[i]);
    if (!obj) continue;
    const msgObj = (obj as { message?: unknown }).message;
    const message = msgObj && typeof msgObj === 'object' ? (msgObj as Record<string, unknown>) : null;
    const stopReason = (obj as { stopReason?: unknown }).stopReason ?? message?.stopReason;
    if (stopReason === 'error' || stopReason === 'refusal' || stopReason === 'max_tokens') {
      const msg = (obj as { errorMessage?: unknown }).errorMessage ?? message?.errorMessage ?? message?.text;
      if (typeof msg === 'string' && msg.trim()) {
        const cleaned = msg.replace(/^(error|Error):\s*/i, '').slice(0, 200);
        return `failed:${cleaned}`;
      }
      return 'failed';
    }
    const errorStatus = (obj as { errorStatus?: unknown }).errorStatus ?? message?.errorStatus;
    if (typeof errorStatus === 'number' && errorStatus >= 400) {
      const msg = (obj as { errorMessage?: unknown }).errorMessage ?? message?.errorMessage;
      if (typeof msg === 'string' && msg.trim()) {
        return `failed:${msg.slice(0, 200)}`;
      }
      return 'failed';
    }
    const type = (obj as { type?: unknown }).type;
    if (type === 'turn.failed' || type === 'agent_error' || type === 'error') {
      const msg = (obj as { message?: unknown }).message ?? (obj as { error?: unknown }).error;
      if (typeof msg === 'string' && msg.trim()) {
        return `failed:${(msg as string).slice(0, 200)}`;
      }
      return 'failed';
    }
  }
  return null;
}
