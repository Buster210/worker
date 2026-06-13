import { spawnSync } from 'child_process';

export function listDescendants(pid: number): number[] {
  const psResult = spawnSync('ps', ['-axo', 'pid=,ppid='], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  });
  const stdout = psResult.stdout ?? '';
  if (!stdout) {
    return listDescendantsLegacy(pid);
  }
  const childrenByPid = new Map<number, number[]>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.lastIndexOf(' ');
    if (spaceIdx === -1) continue;
    const child = Number(trimmed.slice(0, spaceIdx));
    const parent = Number(trimmed.slice(spaceIdx + 1));
    if (!Number.isFinite(child) || !Number.isFinite(parent) || child <= 0 || parent <= 0) continue;
    let arr = childrenByPid.get(parent);
    if (!arr) { arr = []; childrenByPid.set(parent, arr); }
    arr.push(child);
  }
  const result: number[] = [];
  const stack = [pid];
  while (stack.length > 0) {
    const p = stack.pop()!;
    const kids = childrenByPid.get(p);
    if (!kids) continue;
    for (const k of kids) { result.push(k); stack.push(k); }
  }
  return result;
}

function listDescendantsLegacy(pid: number): number[] {
  const result: number[] = [];
  const stack = [pid];
  while (stack.length > 0) {
    const p = stack.pop()!;
    const proc = spawnSync('pgrep', ['-P', String(p)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const stdout = proc.stdout?.toString().trim() ?? '';
    if (!stdout) continue;
    for (const line of stdout.split('\n')) {
      const child = Number(line.trim());
      if (child > 0) { result.push(child); stack.push(child); }
    }
  }
  return result;
}

export function killProcessTree(pid: number, sig: NodeJS.Signals | number = 'SIGKILL'): void {
  if (pid <= 0) return;
  try { process.kill(-pid, sig); } catch {}
  const descendants = listDescendants(pid);
  for (const child of descendants) {
    try { process.kill(child, sig); } catch {}
  }
}

export function killGroup(pid: number, sig: 'SIGTERM' | 'SIGKILL' | 'SIGSTOP' = 'SIGTERM') {
  try { process.kill(-pid, sig); } catch {}
}

const ETIME_RE = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/;
export function parseEtimeSeconds(etime: string): number | null {
  const m = etime.trim().match(ETIME_RE);
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  return Number(dd ?? 0) * 86400 + Number(hh ?? 0) * 3600 + Number(mm) * 60 + Number(ss);
}

const _pidVerified = new Map<number, { started: string; at: number }>();

function getProcessStartTime(pid: number): string | null {
  try {
    const result = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
    if (result.status !== 0) return null;
    const elapsedSec = parseEtimeSeconds(result.stdout);
    if (elapsedSec === null) return null;
    return new Date(Date.now() - elapsedSec * 1000).toISOString();
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number, started?: string): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (!started) return true;
  const cached = _pidVerified.get(pid);
  if (cached && cached.started === started) return true;
  const procStart = getProcessStartTime(pid);
  if (!procStart) return true;
  const skewMs = Math.abs(new Date(procStart).getTime() - new Date(started).getTime());
  if (skewMs < 60_000) _pidVerified.set(pid, { started, at: Date.now() });
  return skewMs < 60_000;
}

export function __resetPidCache(): void { _pidVerified.clear(); }

