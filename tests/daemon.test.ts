import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { acquireLock, readLock, removeLock, isDaemonAlive, SessionTracker } from '../src/daemon.ts';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import http from 'http';

const LOCK_DIR = join(tmpdir(), `worker-daemon-test-${process.pid}`);
const LOCK_PATH = join(LOCK_DIR, 'server.json');


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
    // process.pid is always alive → the live-foreign-lock guard must refuse to
    // steal it. (A dead-pid lock is intentionally reclaimed; see daemon.ts.)
    acquireLock(process.pid, 3000);
    const result = acquireLock(22222, 3001);
    expect(result).toBe(false);
    const lock = readLock();
    expect(lock!.pid).toBe(process.pid);
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
