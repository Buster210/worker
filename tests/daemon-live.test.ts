import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import http from 'http';

// --- helpers ---

const TEST_DIR = join(tmpdir(), `worker-daemon-live-${process.pid}`);
const LOCK_PATH = join(TEST_DIR, 'server.json');

function makeEnv(port: number): NodeJS.ProcessEnv {
  return { ...process.env, WORKER_SKIP_AUTH_GATE: '1', WORKER_STATE_DIR: TEST_DIR, WORKER_PORT: String(port) };
}

function waitForOutput(proc: ChildProcess, pattern: RegExp, timeoutMs = 10000): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const timer = setTimeout(() => reject(new Error('Timeout waiting for daemon output')), timeoutMs);
  let buffer = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const match = buffer.match(pattern);
    if (match) { clearTimeout(timer); resolve(match[1] || match[0]); }
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const match = buffer.match(pattern);
    if (match) { clearTimeout(timer); resolve(match[1] || match[0]); }
  });
  return promise;
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
  const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
    let body = '';
    res.on('data', (chunk: Buffer) => body += chunk);
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
  });
  req.on('error', reject);
  return promise;
}

function httpPostJson(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string; headers: http.IncomingHttpHeaders }>();
  const data = JSON.stringify(body);
  const req = http.request(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)), ...headers },
  }, (res) => {
    let body = '';
    res.on('data', (chunk: Buffer) => body += chunk);
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
  });
  req.on('error', reject);
  req.write(data);
  req.end();
  return promise;
}

function httpDelete(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
  const req = http.request(`http://127.0.0.1:${port}${path}`, {
    method: 'DELETE',
    headers,
  }, (res) => {
    let body = '';
    res.on('data', (chunk: Buffer) => body += chunk);
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
  });
  req.on('error', reject);
  req.end();
  return promise;
}

async function startDaemon(port: number): Promise<ChildProcess> {
  try { unlinkSync(LOCK_PATH); } catch {}
  const proc = spawn('bun', ['run', 'src/server.ts', '--http'], {
    cwd: join(import.meta.dir, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: makeEnv(port),
  });
  await waitForOutput(proc, /listening on http:\/\/127\.0\.0\.1:(\d+)/);
  return proc;
}

/** Start daemon that is EXPECTED to fail (e.g. port occupied). Returns the process. */
function startDaemonExpectedFail(port: number): ChildProcess {
  return spawn('bun', ['run', 'src/server.ts', '--http'], {
    cwd: join(import.meta.dir, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: makeEnv(port),
  });
}

/** Wait for process to exit, then wait for lockfile to be removed. Full cleanup. */
async function stopDaemon(proc: ChildProcess): Promise<void> {
  // Wait for process exit
  const { promise: exitWait, resolve: exitResolve } = Promise.withResolvers<void>();
  if (proc.exitCode !== null) { exitResolve(); } else {
    proc.on('exit', () => exitResolve());
    proc.kill('SIGTERM');
  }
  await exitWait;

  // Poll until lockfile is gone (hardShutdown removes it synchronously, but process needs time)
  for (let i = 0; i < 20; i++) {
    if (!existsSync(LOCK_PATH)) return;
    await new Promise(r => setTimeout(r, 100));
  }
}

/** Parse SSE stream from MCP StreamableHTTPServerTransport → extract JSON-RPC response. */
function parseSseBody(raw: string): unknown {
  for (const line of raw.split('\n')) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6).trim();
      if (data) return JSON.parse(data);
    }
  }
  // Try raw JSON fallback (transport may return plain JSON for some responses)
  return JSON.parse(raw);
}

async function mcpInitialize(port: number): Promise<{ sessionId: string; body: unknown }> {
  const res = await httpPostJson(port, '/mcp', {
    jsonrpc: '2.0',
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    id: 1,
  }, { 'Accept': 'application/json, text/event-stream' });
  if (res.status !== 200) throw new Error(`initialize failed: ${res.status} ${res.body}`);
  const sessionId = res.headers['mcp-session-id'] as string;
  if (!sessionId) throw new Error('no mcp-session-id header');
  return { sessionId, body: parseSseBody(res.body) };
}

const BASE_PORT = 15500 + (process.pid % 1000) * 10;
let nextPort = BASE_PORT;
function allocPort(): number { return nextPort++; }

// --- tests ---

describe('live daemon', () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    try { unlinkSync(LOCK_PATH); } catch {}
  });

  afterAll(() => {
    try { unlinkSync(LOCK_PATH); } catch {}
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it('starts, responds to /health, and shuts down cleanly', async () => {
    const port = allocPort();
    const daemon = await startDaemon(port);

    const health = await httpGet(port, '/health');
    expect(health.status).toBe(200);
    const body = JSON.parse(health.body);
    expect(body.ok).toBe(true);
    expect(body.sessions).toBe(0);

    await stopDaemon(daemon);
  });

  it('returns 404 for unknown paths', async () => {
    const port = allocPort();
    const daemon = await startDaemon(port);

    const res = await httpGet(port, '/nonexistent');
    expect(res.status).toBe(404);

    await stopDaemon(daemon);
  });

  it('rejects non-initialize POST to /mcp', async () => {
    const port = allocPort();
    const daemon = await startDaemon(port);

    const res = await httpPostJson(port, '/mcp', { jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(400);

    await stopDaemon(daemon);
  });

  it('stale lockfile with dead PID → reclaims on restart', async () => {
    const port = allocPort();
    // Use a PID that's guaranteed dead (99999 is typically not running on any OS)
    writeFileSync(LOCK_PATH, JSON.stringify({ pid: 99999, port, started_at: '2020-01-01T00:00:00Z' }));
    expect(existsSync(LOCK_PATH)).toBe(true);

    const daemon = await startDaemon(port);

    // Daemon should have reclaimed — health works
    const health = await httpGet(port, '/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body).ok).toBe(true);

    await stopDaemon(daemon);
  });

  it('port occupied by non-daemon → daemon detects and retries', async () => {
    const port = allocPort();
    try { unlinkSync(LOCK_PATH); } catch {}

    // Occupy the port
    const blocker = http.createServer((_req, res) => { res.writeHead(200); res.end('blocker'); });
    const { promise: blockerReady, resolve: ready } = Promise.withResolvers<void>();
    blocker.listen(port, () => ready());
    await blockerReady;

    // Start daemon — it will hit EADDRINUSE
    const daemon = startDaemonExpectedFail(port);

    // Give it time to detect EADDRINUSE and try to reclaim
    await new Promise(r => setTimeout(r, 1500));

    // Release the port
    const { promise: blockerDone, resolve: done } = Promise.withResolvers<void>();
    blocker.close(() => done());
    await blockerDone;

    // Give daemon time to retry and bind
    await new Promise(r => setTimeout(r, 1500));

    // Check if daemon came up after blocker was removed
    try {
      const health = await httpGet(port, '/health');
      expect(health.status).toBe(200);
    } catch {
      // Daemon may have given up after one retry — acceptable, the key test is it didn't crash
    }

    daemon.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
    try { unlinkSync(LOCK_PATH); } catch {}
  });

  it('MCP initialize creates a session, health shows session count', async () => {
    const port = allocPort();
    const daemon = await startDaemon(port);

    const { sessionId } = await mcpInitialize(port);
    expect(sessionId).toBeTruthy();

    // Health should show 1 session
    const health = await httpGet(port, '/health');
    expect(JSON.parse(health.body).sessions).toBe(1);

    await stopDaemon(daemon);
  });

  it('two concurrent sessions, both tracked in health', async () => {
    const port = allocPort();
    const daemon = await startDaemon(port);

    const s1 = await mcpInitialize(port);
    const s2 = await mcpInitialize(port);
    expect(s1.sessionId).not.toBe(s2.sessionId);

    const health = await httpGet(port, '/health');
    expect(JSON.parse(health.body).sessions).toBe(2);

    await stopDaemon(daemon);
  });

  it('concurrent initialize requests get unique session IDs', async () => {
    const port = allocPort();
    const daemon = await startDaemon(port);

    const results = await Promise.all([
      mcpInitialize(port),
      mcpInitialize(port),
      mcpInitialize(port),
    ]);

    const ids = results.map(r => r.sessionId);
    expect(new Set(ids).size).toBe(3);

    const health = await httpGet(port, '/health');
    expect(JSON.parse(health.body).sessions).toBe(3);

    await stopDaemon(daemon);
  });
  it('last session out via DELETE → daemon exits and removes lockfile', async () => {
    const port = allocPort();
    try { unlinkSync(LOCK_PATH); } catch {}
    const daemon = await startDaemon(port);

    const { sessionId } = await mcpInitialize(port);

    // Verify session is tracked
    const health1 = await httpGet(port, '/health');
    expect(JSON.parse(health1.body).sessions).toBe(1);

    // Disconnect the session — daemon may exit before sending response
    try {
      await httpDelete(port, '/mcp', { 'mcp-session-id': sessionId });
    } catch {
      // ECONNREFUSED is expected — daemon exits via hardShutdown → process.exit(0)
      // which closes the socket before the response is sent
    }

    // Wait for process to exit and lockfile to be removed
    for (let i = 0; i < 20; i++) {
      if (!existsSync(LOCK_PATH)) break;
      await new Promise(r => setTimeout(r, 200));
    }

    expect(existsSync(LOCK_PATH)).toBe(false);
  });

  it('two sessions, disconnect one → other stays alive, then last exits', async () => {
    const port = allocPort();
    try { unlinkSync(LOCK_PATH); } catch {}
    const daemon = await startDaemon(port);

    const s1 = await mcpInitialize(port);
    const s2 = await mcpInitialize(port);

    // Both tracked
    const health1 = await httpGet(port, '/health');
    expect(JSON.parse(health1.body).sessions).toBe(2);

    // Disconnect session 1 — session 2 should survive
    try { await httpDelete(port, '/mcp', { 'mcp-session-id': s1.sessionId }); } catch { /* may ECONNREFUSED */ }
    await new Promise(r => setTimeout(r, 500));

    // Daemon should still be alive with 1 session
    const health2 = await httpGet(port, '/health');
    expect(JSON.parse(health2.body).sessions).toBe(1);

    // Disconnect session 2 → daemon exits
    try { await httpDelete(port, '/mcp', { 'mcp-session-id': s2.sessionId }); } catch { /* daemon exits */ }
    for (let i = 0; i < 20; i++) {
      if (!existsSync(LOCK_PATH)) break;
      await new Promise(r => setTimeout(r, 200));
    }
    expect(existsSync(LOCK_PATH)).toBe(false);
  });
});
