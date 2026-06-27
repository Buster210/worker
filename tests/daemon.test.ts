import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { acquireLock, readLock, removeLock, isDaemonAlive, SessionTracker } from '../src/daemon.ts';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import http from 'http';

const LOCK_DIR = join(tmpdir(), `worker-daemon-test-${process.pid}`);
const LOCK_PATH = join(LOCK_DIR, 'server.json');

const TEST_DIR = join(tmpdir(), `worker-daemon-live-${process.pid}`);
const TEST_LOCK_PATH = join(TEST_DIR, 'server.json');

process.env.WORKER_STATE_DIR = LOCK_DIR;

describe('lockfile protocol', () => {
  beforeEach(() => {
    try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch {}
    mkdirSync(LOCK_DIR, { recursive: true });
  });

  it('acquireLock creates lockfile atomically', () => {
    const result = acquireLock(12345, 54321);
    expect(result).toBe(true);
    expect(existsSync(LOCK_PATH)).toBe(true);
    const lock = readLock();
    expect(lock).not.toBeNull();
    expect(lock!.pid).toBe(12345);
    expect(lock!.port).toBe(54321);
  });

  it('acquireLock returns false when a live holder owns the lock', () => {
    acquireLock(process.pid, 3000);
    const result = acquireLock(22222, 3001);
    expect(result).toBe(false);
    const lock = readLock();
    expect(lock!.pid).toBe(process.pid);
  });

  it('acquireLock reclaims stale lock from dead PID', () => {
    const staleLock = { pid: 9999999, port: 5000, started_at: new Date().toISOString() };
    writeFileSync(LOCK_PATH, JSON.stringify(staleLock));
    const result = acquireLock(12345, 54321);
    expect(result).toBe(true);
    const lock = readLock();
    expect(lock!.pid).toBe(12345);
    expect(lock!.port).toBe(54321);
  });

  it('readLock returns null for missing lockfile', () => {
    expect(readLock()).toBeNull();
  });

  it('readLock returns null for corrupt lockfile', () => {
    writeFileSync(LOCK_PATH, 'not json');
    expect(readLock()).toBeNull();
  });

  it('removeLock deletes lockfile', () => {
    acquireLock(99999, 9999);
    expect(existsSync(LOCK_PATH)).toBe(true);
    removeLock();
    expect(existsSync(LOCK_PATH)).toBe(false);
  });

  it('acquireLock returns false on non-EEXIST openSync failure', () => {
    chmodSync(LOCK_DIR, 0o555);
    try {
      expect(acquireLock(55555, 3001)).toBe(false);
    } finally {
      chmodSync(LOCK_DIR, 0o755);
    }
  });

  it('isDaemonAlive returns false for dead PID', async () => {
    const alive = await isDaemonAlive({ pid: 9999999, port: 54321, started_at: new Date().toISOString() });
    expect(alive).toBe(false);
  });

  it('isDaemonAlive returns false for non-responsive port', async () => {
    const alive = await isDaemonAlive({ pid: process.pid, port: 59999, started_at: new Date().toISOString() });
    expect(alive).toBe(false);
  });
});

describe('SessionTracker', () => {
  it('register + get stores entry', () => {
    const tracker = new SessionTracker();
    const mockTransport = { close: async () => {}, handleRequest: async () => ({}), sessionId: 'mcp-1' };
    const mockServer = { sendLoggingMessage: async () => {} };
    tracker.register('mcp-1', { transport: mockTransport as never, server: mockServer as never, lastSeen: Date.now() });
    expect(tracker.size).toBe(1);
    const entry = tracker.get('mcp-1');
    expect(entry).toBeDefined();
  });

  it('remove returns entry and deletes it', () => {
    const tracker = new SessionTracker();
    const mockTransport = { close: async () => {} };
    const mockServer = { sendLoggingMessage: async () => {} };
    tracker.register('mcp-1', { transport: mockTransport as never, server: mockServer as never, lastSeen: Date.now() });
    const removed = tracker.remove('mcp-1');
    expect(removed).toBeDefined();
    expect(tracker.size).toBe(0);
    expect(tracker.get('mcp-1')).toBeUndefined();
  });

  it('remove returns undefined for unknown session', () => {
    const tracker = new SessionTracker();
    expect(tracker.remove('unknown')).toBeUndefined();
  });

  it('entries yields all registered sessions', () => {
    const tracker = new SessionTracker();
    const mockTransport = { close: async () => {} };
    const mockServer = { sendLoggingMessage: async () => {} };
    tracker.register('mcp-1', { transport: mockTransport as never, server: mockServer as never, lastSeen: Date.now() });
    tracker.register('mcp-2', { transport: mockTransport as never, server: mockServer as never, lastSeen: Date.now() });
    const entries = [...tracker.entries()];
    expect(entries.length).toBe(2);
    expect(entries.map(e => e[0]).sort()).toEqual(['mcp-1', 'mcp-2']);
  });

  it('reapIdle drops only stale sessions, keeps fresh ones', () => {
    const tracker = new SessionTracker();
    let closed = 0;
    const mockTransport = { close: async () => { closed++; } };
    const mockServer = { sendLoggingMessage: async () => {} };
    tracker.register('stale', { transport: mockTransport as never, server: mockServer as never, lastSeen: Date.now() - 60_000 });
    tracker.register('fresh', { transport: mockTransport as never, server: mockServer as never, lastSeen: Date.now() });
    const reaped = tracker.reapIdle(30_000);
    expect(reaped).toBe(1);
    expect(closed).toBe(1);
    expect(tracker.get('stale')).toBeUndefined();
    expect(tracker.get('fresh')).toBeDefined();
  });
});

describe('HTTP daemon integration', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessions: 0 }));
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(() => {
    server.close();
  });

  it('health endpoint returns ok', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { ok: boolean; sessions: number };
    expect(body.ok).toBe(true);
    expect(body.sessions).toBe(0);
  });

  it('isDaemonAlive detects live daemon', async () => {
    const alive = await isDaemonAlive({ pid: process.pid, port, started_at: new Date().toISOString() });
    expect(alive).toBe(true);
  });
});

function makeLiveEnv(port: number): NodeJS.ProcessEnv {
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
  try { unlinkSync(TEST_LOCK_PATH); } catch {}
  const proc = spawn('bun', ['run', 'src/server.ts'], {
    cwd: join(import.meta.dir, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: makeLiveEnv(port),
  });
  await waitForOutput(proc, /listening on http:\/\/127\.0\.0\.1:(\d+)/);
  return proc;
}

function startDaemonExpectedFail(port: number): ChildProcess {
  return spawn('bun', ['run', 'src/server.ts'], {
    cwd: join(import.meta.dir, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: makeLiveEnv(port),
  });
}

async function stopDaemon(proc: ChildProcess): Promise<void> {
  const { promise: exitWait, resolve: exitResolve } = Promise.withResolvers<void>();
  if (proc.exitCode !== null) { exitResolve(); } else {
    proc.on('exit', () => exitResolve());
    proc.kill('SIGTERM');
  }
  await exitWait;

  for (let i = 0; i < 20; i++) {
    if (!existsSync(TEST_LOCK_PATH)) return;
    await new Promise(r => setTimeout(r, 100));
  }
}

function parseSseBody(raw: string): unknown {
  for (const line of raw.split('\n')) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6).trim();
      if (data) return JSON.parse(data);
    }
  }
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

describe('live daemon', () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    try { unlinkSync(TEST_LOCK_PATH); } catch {}
  });

  afterAll(() => {
    try { unlinkSync(TEST_LOCK_PATH); } catch {}
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
    writeFileSync(TEST_LOCK_PATH, JSON.stringify({ pid: 99999, port, started_at: '2020-01-01T00:00:00Z' }));
    expect(existsSync(TEST_LOCK_PATH)).toBe(true);

    const daemon = await startDaemon(port);

    const health = await httpGet(port, '/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body).ok).toBe(true);

    await stopDaemon(daemon);
  });

  it('port occupied by non-daemon → daemon detects and retries', async () => {
    const port = allocPort();
    try { unlinkSync(TEST_LOCK_PATH); } catch {}

    const blocker = http.createServer((_req, res) => { res.writeHead(200); res.end('blocker'); });
    const { promise: blockerReady, resolve: ready } = Promise.withResolvers<void>();
    blocker.listen(port, () => ready());
    await blockerReady;

    const daemon = startDaemonExpectedFail(port);

    await new Promise(r => setTimeout(r, 1500));

    const { promise: blockerDone, resolve: done } = Promise.withResolvers<void>();
    blocker.close(() => done());
    await blockerDone;

    await new Promise(r => setTimeout(r, 1500));

    try {
      const health = await httpGet(port, '/health');
      expect(health.status).toBe(200);
    } catch {
    }

    daemon.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
    try { unlinkSync(TEST_LOCK_PATH); } catch {}
  });

  it('MCP initialize creates a session, health shows session count', async () => {
    const port = allocPort();
    const daemon = await startDaemon(port);

    const { sessionId } = await mcpInitialize(port);
    expect(sessionId).toBeTruthy();

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

  it('last session out via DELETE → daemon stays alive; only SIGTERM exits', async () => {
    const port = allocPort();
    const daemon = await startDaemon(port);

    const { sessionId } = await mcpInitialize(port);
    expect(JSON.parse((await httpGet(port, '/health')).body).sessions).toBe(1);

    try { await httpDelete(port, '/mcp', { 'mcp-session-id': sessionId }); } catch {}

    await new Promise(r => setTimeout(r, 500));
    expect(existsSync(TEST_LOCK_PATH)).toBe(true);
    expect(JSON.parse((await httpGet(port, '/health')).body).sessions).toBe(0);

    await stopDaemon(daemon);
    expect(existsSync(TEST_LOCK_PATH)).toBe(false);
  });

  it('two sessions, disconnect one → other stays; last out keeps daemon alive', async () => {
    const port = allocPort();
    const daemon = await startDaemon(port);

    const s1 = await mcpInitialize(port);
    const s2 = await mcpInitialize(port);
    expect(JSON.parse((await httpGet(port, '/health')).body).sessions).toBe(2);

    try { await httpDelete(port, '/mcp', { 'mcp-session-id': s1.sessionId }); } catch {}
    await new Promise(r => setTimeout(r, 500));
    expect(JSON.parse((await httpGet(port, '/health')).body).sessions).toBe(1);

    try { await httpDelete(port, '/mcp', { 'mcp-session-id': s2.sessionId }); } catch {}
    await new Promise(r => setTimeout(r, 500));
    expect(existsSync(TEST_LOCK_PATH)).toBe(true);
    expect(JSON.parse((await httpGet(port, '/health')).body).sessions).toBe(0);

    await stopDaemon(daemon);
    expect(existsSync(TEST_LOCK_PATH)).toBe(false);
  });
});
