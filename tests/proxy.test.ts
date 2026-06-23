import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, unlinkSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import http from 'http';

const TEST_DIR = join(tmpdir(), `worker-proxy-${process.pid}`);
const LOCK_PATH = join(TEST_DIR, 'server.json');

function makeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WORKER_SKIP_AUTH_GATE: '1',
    WORKER_STATE_DIR: TEST_DIR,
    HOME: process.env.HOME, // keep bun accessible
  };
}

function allocPort(): number {
  return 20000 + Math.floor(Math.random() * 40000);
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

function writeFrame(msg: unknown): Buffer {
  const body = JSON.stringify(msg);
  const buf = Buffer.from(body, 'utf-8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${buf.length}\r\n\r\n`),
    buf,
  ]);
}

function readFrame(data: Buffer): unknown {
  const headerEnd = data.indexOf('\r\n\r\n');
  if (headerEnd === -1) throw new Error('No header end found');
  const header = data.toString('utf-8', 0, headerEnd);
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) throw new Error('No Content-Length');
  const bodyLen = parseInt(match[1], 10);
  const bodyStart = headerEnd + 4;
  return JSON.parse(data.toString('utf-8', bodyStart, bodyStart + bodyLen));
}

async function waitForProxyOutput(proc: ChildProcess, timeoutMs = 15000): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const timer = setTimeout(() => { proc.stdout!.removeListener('data', onData); reject(new Error('Timeout waiting for proxy output')); }, timeoutMs);
  const chunks: Buffer[] = [];
  function onData(chunk: Buffer) {
    chunks.push(chunk);
    const combined = Buffer.concat(chunks);
    const headerEnd = combined.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const header = combined.toString('utf-8', 0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (match) {
        const bodyLen = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        if (combined.length >= bodyStart + bodyLen) {
          clearTimeout(timer);
          proc.stdout!.removeListener('data', onData);
          resolve(combined.subarray(0, bodyStart + bodyLen));
        }
      }
    }
  }
  proc.stdout!.on('data', onData);
  return promise;
}

function killProc(proc: ChildProcess) {
  try { proc.kill('SIGTERM'); } catch {}
}

function cleanup() {
  if (existsSync(LOCK_PATH)) {
    try {
      const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf-8'));
      if (lock.pid) process.kill(lock.pid, 'SIGTERM');
    } catch {}
    try { unlinkSync(LOCK_PATH); } catch {}
  }
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  cleanup();
  try { rmSync(TEST_DIR, { recursive: true }); } catch {}
});

describe('proxy → daemon auto-discovery', () => {
  let proxy: ChildProcess | undefined;

  afterAll(() => {
    if (proxy) killProc(proxy);
    cleanup();
  });

  it('auto-starts daemon and bridges initialize', async () => {
    expect(existsSync(LOCK_PATH)).toBe(false);

    proxy = spawn('bun', ['run', join(import.meta.dir, '..', 'src', 'proxy.ts')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: makeEnv(),
    });

    const initMsg = {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'proxy-test', version: '1.0.0' },
      },
      id: 1,
    };

    proxy.stdin!.write(writeFrame(initMsg));
    const raw = await waitForProxyOutput(proxy);
    const resp = readFrame(raw) as Record<string, unknown>;

    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.id).toBe(1);
    expect(resp.result).toBeDefined();

    const result = resp.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo).toBeDefined();
  });

  it('connects to existing daemon instead of starting new one', async () => {
    // Lockfile still exists from previous test — daemon should be running
    expect(existsSync(LOCK_PATH)).toBe(true);
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf-8'));

    const proxy2 = spawn('bun', ['run', join(import.meta.dir, '..', 'src', 'proxy.ts')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: makeEnv(),
    });

    try {
      const initMsg = {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'proxy-test-2', version: '1.0.0' },
        },
        id: 1,
      };

      proxy2.stdin!.write(writeFrame(initMsg));
      const raw = await waitForProxyOutput(proxy2);
      const resp = readFrame(raw) as Record<string, unknown>;

      expect(resp.result).toBeDefined();
      // Daemon should still be the same one
      expect(existsSync(LOCK_PATH)).toBe(true);
      const lock2 = JSON.parse(readFileSync(LOCK_PATH, 'utf-8'));
      expect(lock2.pid).toBe(lock.pid);
    } finally {
      killProc(proxy2);
    }
  });
});

describe('proxy → daemon tool calls', () => {
  let proxy: ChildProcess | undefined;
  let sessionId: string | undefined;

  afterAll(() => {
    if (proxy) killProc(proxy);
    cleanup();
  });

  it('forwards tools/list through the bridge', async () => {
    proxy = spawn('bun', ['run', join(import.meta.dir, '..', 'src', 'proxy.ts')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: makeEnv(),
    });

    // Initialize first
    const initMsg = {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'proxy-tools-test', version: '1.0.0' },
      },
      id: 1,
    };

    proxy.stdin!.write(writeFrame(initMsg));
    const initRaw = await waitForProxyOutput(proxy);
    const initResp = readFrame(initRaw) as Record<string, unknown>;
    expect(initResp.result).toBeDefined();

    // Send initialized notification
    proxy.stdin!.write(writeFrame({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    // Wait for proxy to process notification before sending next request
    await new Promise(r => setTimeout(r, 200));

    // Send tools/list
    const listMsg = {
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
      id: 2,
    };

    proxy.stdin!.write(writeFrame(listMsg));
    const listRaw = await waitForProxyOutput(proxy);
    const listResp = readFrame(listRaw) as Record<string, unknown>;

    expect(listResp.id).toBe(2);
    expect(listResp.result).toBeDefined();
    const tools = (listResp.result as Record<string, unknown>).tools as unknown[];
    expect(tools.length).toBeGreaterThan(0);
    const toolNames = tools.map((t) => (t as Record<string, unknown>).name);
    expect(toolNames).toContain('worker_ladder');
  });
});

describe('proxy handles stale daemon', () => {
  it('reclaims stale lockfile and starts fresh daemon', async () => {
    cleanup();

    // Write a fake lockfile with dead PID
    mkdirSync(TEST_DIR, { recursive: true });
    const fakeLock = { pid: 99999, port: allocPort(), started_at: new Date().toISOString() };
    require('fs').writeFileSync(LOCK_PATH, JSON.stringify(fakeLock));

    const proxy = spawn('bun', ['run', join(import.meta.dir, '..', 'src', 'proxy.ts')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: makeEnv(),
    });

    try {
      const initMsg = {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'proxy-stale-test', version: '1.0.0' },
        },
        id: 1,
      };

      proxy.stdin!.write(writeFrame(initMsg));
      const raw = await waitForProxyOutput(proxy);
      const resp = readFrame(raw) as Record<string, unknown>;

      expect(resp.result).toBeDefined();

      // Lockfile should now point to new daemon
      const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf-8'));
      expect(lock.pid).not.toBe(99999);
      expect(lock.pid).toBeGreaterThan(0);
    } finally {
      killProc(proxy);
    }
  });
});
