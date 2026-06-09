/**
 * Pure log-parsing logic — no runner/state/child_process imports, only `fs`.
 * Single entry point for tail reads so callers never read the tail twice.
 */
import { statSync, openSync, readSync, closeSync } from 'fs';

function envBytes(key: string, def: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const STATUS_TAIL_BYTES = envBytes('WORKER_STATUS_TAIL_BYTES', 1_048_576);

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
      // If we didn't start at offset 0, drop the first (partial) line.
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

/** Extract assistant text chunks from a single JSONL event line. */
export function extractAssistantTexts(line: string): string[] {
  try {
    const obj: unknown = JSON.parse(line);
    if (
      obj !== null && typeof obj === 'object' &&
      'message' in obj && typeof (obj as { message: unknown }).message === 'object' &&
      (obj as { message: { role?: unknown } }).message.role === 'assistant' &&
      Array.isArray((obj as { message: { content?: unknown } }).message.content)
    ) {
      const msg = (obj as { message: { content: Array<{ type?: string; text?: string }> } }).message;
      return msg.content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string);
    }
  } catch {}
  return [];
}

export type SentinelResult = 'done' | `failed:${string}` | 'failed' | null;

/** Pure walk-from-end sentinel detection on candidate lines. */
export function matchSentinel(lines: string[]): SentinelResult {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/^DONE(\s|$)/.test(line)) return 'done';
    if (/^FAILED(:|\s|$)/.test(line)) {
      const reason = line.replace(/^FAILED:?\s*/, '').trim();
      return reason ? `failed:${reason}` : 'failed';
    }
  }
  return null;
}

/**
 * Single entry point for sentinel reading — does ONE tailCapped read, splits
 * to non-empty lines, optionally extracts assistant texts for JSON backends,
 * then returns { status, lastText }. Callers never read the tail twice.
 */
export function readSentinel(logPath: string, json: boolean): { status: SentinelResult; lastText: string } {
  const lines = tailCapped(logPath).split('\n').filter(Boolean);
  const candidates = json ? lines.flatMap(extractAssistantTexts) : lines;
  return { status: matchSentinel(candidates), lastText: candidates[candidates.length - 1] ?? '' };
}
