#!/usr/bin/env bun
/**
 * Stdio-to-HTTP bridge for the worker MCP daemon.
 *
 * Claude Code spawns this as its MCP server over stdio. This script:
 *   1. Checks ~/.claude/workers/server.json for a running daemon
 *   2. If alive → connects to it via HTTP
 *   3. If not → starts one, waits for lockfile, then connects
 *   4. Bridges stdio MCP framing ↔ HTTP POST to /mcp
 *
 * Multiple Claude Code sessions share one daemon process.
 */
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const LOCK_PATH = () => {
  const stateDir = process.env.WORKER_STATE_DIR || `${process.env.HOME}/.claude/workers`;
  return `${stateDir}/server.json`;
};

interface Lock { pid: number; port: number }

function readLock(): Lock | null {
  try {
    const raw = readFileSync(LOCK_PATH(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.pid === 'number' && typeof parsed.port === 'number') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function isDaemonAlive(lock: Lock): Promise<boolean> {
  if (!isProcessAlive(lock.pid)) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function startDaemon(): ChildProcess {
  const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'server.ts');
  // Use port 0 so the OS picks a free port — avoids collisions with orphaned daemons
  return spawn(process.execPath, ['run', scriptPath, '--http'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, WORKER_PORT: '0' },
  });
}

async function waitForDaemon(timeoutMs = 15000): Promise<Lock> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const lock = readLock();
    if (lock && await isDaemonAlive(lock)) return lock;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Daemon failed to start within timeout');
}

async function getDaemonConnection(): Promise<Lock> {
  const existing = readLock();
  if (existing && await isDaemonAlive(existing)) return existing;

  // Stale lockfile — remove it so acquireLock can create a new one
  if (existing) {
    try { unlinkSync(LOCK_PATH()); } catch {}
  }

  // Start fresh daemon
  const child = startDaemon();
  child.unref(); // don't let wrapper keep daemon alive
  return waitForDaemon();
}

// --- Stdio MCP framing: newline-delimited JSON (MCP SDK uses \n, not Content-Length) ---

function writeStdout(data: string) {
  process.stdout.write(data + '\n');
}

// Persistent buffer so leftover bytes from one line aren't lost across chunks.
let stdinBuf = Buffer.alloc(0);

function readStdinFrame(): Promise<string> {
  return new Promise((resolve, reject) => {
    function tryParse() {
      const nl = stdinBuf.indexOf('\n');
      if (nl === -1) return false;
      const line = stdinBuf.toString('utf-8', 0, nl).trimEnd();
      stdinBuf = stdinBuf.slice(nl + 1);
      if (line) { resolve(line); return true; }
      return false; // skip blank lines
    }

    if (tryParse()) return;

    function onChunk(chunk: Buffer) {
      stdinBuf = Buffer.concat([stdinBuf, chunk]);
      if (tryParse()) process.stdin.removeListener('data', onChunk);
    }

    process.stdin.on('data', onChunk);
    process.stdin.on('end', () => reject(new Error('stdin closed')));
  });
}

// --- Main ---

// Consume an SSE response body in the background, forwarding each data: line to stdout.
// StreamableHTTPServerTransport keeps the initialize SSE stream open for server push —
// we must not await it, or the main stdin loop stalls forever.
function consumeSseBackground(body: ReadableStream<Uint8Array>) {
  void (async () => {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line.startsWith('data: ')) writeStdout(line.slice(6));
        }
      }
    } catch {}
  })();
}

export async function runBridge() {
  // Attach early so frames sent before getDaemonConnection() resolves aren't missed.
  process.stdin.on('data', (chunk: Buffer) => { stdinBuf = Buffer.concat([stdinBuf, chunk]); });
  const lock = await getDaemonConnection();
  const port = lock.port;

  let sessionHeader = '';

  process.stderr.write(`[worker-bridge] connected to daemon on port ${port}\n`);
  process.stderr.write = () => true;

  try {
    while (true) {
      const body = await readStdinFrame();
      const msg = JSON.parse(body);
      const isNotification = !('id' in msg);
      const isInit = msg.method === 'initialize';

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      };
      if (sessionHeader && !isInit) headers['mcp-session-id'] = sessionHeader;

      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers,
        body,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid && !sessionHeader) sessionHeader = sid;

      if (isNotification) {
        res.body?.cancel();
        continue;
      }

      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('text/event-stream') && res.body) {
        consumeSseBackground(res.body);
      } else {
        writeStdout(await res.text());
      }
    }
  } catch {
    process.exit(0);
  }
}
if (import.meta.main) runBridge();

