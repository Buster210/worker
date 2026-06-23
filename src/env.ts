import { spawn, spawnSync } from 'child_process';
import { statSync, writeFileSync, readFileSync, renameSync } from 'fs';
import { workersDir } from './state.ts';
import { FILE_CONFIG } from './config.ts';

export function envMs(key: string, def: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

export function defaultTimeoutMs(): number { return envMs('WORKER_TIMEOUT_MS', 600_000); }
export function watchdogMs(): number { return envMs('WORKER_WATCHDOG_MS', 5_000); }
export function stallTimeoutMs(): number { return envMs('WORKER_STALL_MS', 60_000); }
export function quietStallMs(): number { return envMs('WORKER_STALL_MS_QUIET', 240_000); }
export function reapAgeMs(): number { return envMs('WORKER_REAP_MS', 900_000); }
export function nearExpiryMs(): number { return envMs('WORKER_NEAR_EXPIRY_MS', 30_000); }
export function graceMs(): number { return envMs('WORKER_GRACE_MS', 60_000); }
export function authProbeMs(): number { return envMs('WORKER_AUTH_PROBE_MS', 2_000); }
export function maxTurns(): number { return envMs('WORKER_MAX_TURNS', 10_000); }

// ponytail: clamp spawned backends (and every cargo/rustc/etc they fork) to a
// macOS QoS band so heavy builds yield under contention instead of pinning all
// cores hot. Lossless — work still completes, just at lower scheduling priority.
// 'utility' (default) = throttle but keep decent throughput; 'background'/
// 'maintenance' = harder throttle; 'off' = disable. macOS-only (taskpolicy).
// Upgrade path: per-backend QoS if one backend needs full speed.
export function cpuThrottleArgv(): string[] {
  if (process.platform !== 'darwin') return [];
  const q = (process.env.WORKER_CPU_QOS ?? FILE_CONFIG.cpuQos ?? 'utility').toLowerCase();
  if (!['utility', 'background', 'maintenance'].includes(q)) return [];
  return ['/usr/sbin/taskpolicy', '-c', q];
}

const HOME = process.env.HOME ?? '';

const LOGIN_ENV_MARKER = '__WORKER_ENV_a7f3__';
let _loginEnvCache: Record<string, string> | null | undefined;

export function parseEnvSnapshot(stdout: string, marker: string): Record<string, string> | null {
  const idx = stdout.indexOf(marker);
  if (idx === -1) return null;
  const jsonStart = stdout.indexOf('{', idx + marker.length);
  if (jsonStart === -1) return null;
  try { return JSON.parse(stdout.slice(jsonStart)); } catch { return null; }
}

export function loginEnvSig(shell: string): string {
  const home = process.env.HOME ?? '';
  const paths = [
    `${home}/.zshenv`, `${home}/.zprofile`, `${home}/.zlogin`, `${home}/.zshrc`,
    `${home}/.bash_profile`, `${home}/.bash_login`, `${home}/.bashrc`, `${home}/.profile`,
    '/etc/zshenv', '/etc/zprofile', '/etc/zlogin', '/etc/zshrc',
    '/etc/profile', '/etc/bashrc', '/etc/bash.bashrc',
  ];
  const parts = paths.map(p => { try { return `${p}:${statSync(p).mtimeMs}`; } catch { return `${p}:-`; } });
  return `${shell}\n${parts.join('\n')}`;
}
export function loginEnvCachePath(): string { return `${workersDir()}/.login-env.json`; }
export function __resetLoginEnvCache(): void {
  _loginEnvCache = undefined;
  _workerEnv = undefined;
}
export function __isWorkerEnvBuilt(): boolean { return _workerEnv !== undefined; }

export function loginShellEnv(): Record<string, string> | null {
  // Disabled when WORKER_LOGIN_SHELL='0' OR (WORKER_LOGIN_SHELL unset AND FILE_CONFIG.loginShell === false)
  const loginShellEnvRaw = process.env.WORKER_LOGIN_SHELL;
  if (loginShellEnvRaw === '0' || (loginShellEnvRaw === undefined && FILE_CONFIG.loginShell === false)) return null;
  if (_loginEnvCache !== undefined) return _loginEnvCache;
  const shell = process.env.SHELL ?? '/bin/zsh';
  const sig = loginEnvSig(shell);
  const cachePath = loginEnvCachePath();
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as { shell?: string; sig?: string; env?: Record<string, string> };
    if (cached.shell === shell && cached.sig === sig && cached.env) {
      _loginEnvCache = cached.env;
      return cached.env;
    }
  } catch {}
  const bunPath = process.execPath;
  const snippet =
    `printf '%s\\n' '${LOGIN_ENV_MARKER}'; exec "${bunPath}" -e 'process.stdout.write(JSON.stringify(process.env))'`;
  try {
    const r = spawnSync(shell, ['-l', '-c', snippet], { encoding: 'utf8', timeout: 5000 });
    if (r.error || r.status !== 0) { _loginEnvCache = null; return null; }
    const parsed = parseEnvSnapshot(r.stdout ?? '', LOGIN_ENV_MARKER);
    _loginEnvCache = parsed;
    if (parsed) {
      try {
        const tmp = `${cachePath}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ shell, sig, env: parsed }));
        renameSync(tmp, cachePath);
      } catch {}
    }
    return parsed;
  } catch {
    _loginEnvCache = null;
    return null;
  }
}

export async function loginShellEnvAsync(): Promise<Record<string, string> | null> {
  // Disabled when WORKER_LOGIN_SHELL='0' OR (WORKER_LOGIN_SHELL unset AND FILE_CONFIG.loginShell === false)
  const loginShellEnvRaw = process.env.WORKER_LOGIN_SHELL;
  if (loginShellEnvRaw === '0' || (loginShellEnvRaw === undefined && FILE_CONFIG.loginShell === false)) return null;
  if (_loginEnvCache !== undefined) return _loginEnvCache;
  const shell = process.env.SHELL ?? '/bin/zsh';
  const sig = loginEnvSig(shell);
  const cachePath = loginEnvCachePath();
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as { shell?: string; sig?: string; env?: Record<string, string> };
    if (cached.shell === shell && cached.sig === sig && cached.env) {
      _loginEnvCache = cached.env;
      return cached.env;
    }
  } catch {}
  const bunPath = process.execPath;
  const snippet = `printf '%s\\n' '${LOGIN_ENV_MARKER}'; exec "${bunPath}" -e 'process.stdout.write(JSON.stringify(process.env))'`;
  return new Promise<Record<string, string> | null>(resolve => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (stdout: string) => {
      if (settled) return;
      settled = true;
      const parsed = parseEnvSnapshot(stdout, LOGIN_ENV_MARKER);
      _loginEnvCache = parsed;
      if (parsed) {
        try {
          const tmp = `${cachePath}.${process.pid}.tmp`;
          writeFileSync(tmp, JSON.stringify({ shell, sig, env: parsed }));
          renameSync(tmp, cachePath);
        } catch {}
      }
      resolve(parsed);
    };
    const p = spawn(shell, ['-l', '-c', snippet], { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout?.on('data', (d: Buffer) => chunks.push(d));
    const kill = setTimeout(() => { p.kill(); finish(''); }, 5000);
    p.on('close', () => { clearTimeout(kill); finish(Buffer.concat(chunks).toString()); });
    p.on('error', () => { clearTimeout(kill); _loginEnvCache = null; finish(''); });
  });
}

let _workerEnv: NodeJS.ProcessEnv | undefined;
export function workerEnv(): NodeJS.ProcessEnv {
  if (_workerEnv) return _workerEnv;
  const loginEnv = loginShellEnv();
  _workerEnv = {
    ...(loginEnv ?? {}),
    ...process.env,
    WORKER_RC: process.env.WORKER_RC ?? FILE_CONFIG.rc ?? `${HOME}/.common`,
    PATH: [
      `${HOME}/.bun/bin`,
      `${HOME}/.local/bin`,
      `${HOME}/.cargo/bin`,
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      loginEnv?.PATH ?? process.env.PATH ?? '',
    ].join(':'),
  };
  return _workerEnv;
}
