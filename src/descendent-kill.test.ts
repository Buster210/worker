import { describe, it, expect, afterAll } from 'bun:test';
import { spawnSync, spawn } from 'child_process';
import { listDescendants, killProcessTree } from './process.ts'

// Spawn a detached process tree: top pid forks a child, which forks a grandchild,
// which forks a great-grandchild — all `sleep 30`.
function spawnTree(): { topPid: number; allPids: number[] } {
  // Use a single script that forks 3 nested sleep children via bash subshells.
  const script = 'sleep 30 & exec sleep 30'; // 2 children; each backgrounded child also forks
  // Simpler: chain 4 levels explicitly.
  const fullScript = [
    'sleep 30 &',          // child 1
    'sleep 30 &',          // child 2
    'exec sleep 30',       // replace self (top becomes grandchild-ish)
  ].join(' ');
  const proc = spawn('bash', ['-c', fullScript], {
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  const topPid = proc.pid!;

  // Give the tree time to spawn.
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const desc = listDescendants(topPid);
    if (desc.length >= 2) break;
    spawnSync('sleep', ['0.05']);
  }

  const descendants = listDescendants(topPid);
  return { topPid, allPids: [topPid, ...descendants] };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  // kill(pid,0) succeeds for zombies — check actual state via ps.
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
  const stat = ps.stdout?.toString().trim() ?? '';
  return !stat.startsWith('Z');
}

const allSpawned: number[] = [];

afterAll(() => {
  // Cleanup: best-effort kill anything still alive.
  for (const p of allSpawned) {
    try { process.kill(p, 'SIGKILL'); } catch {}
  }
});

describe('listDescendants', () => {
  it('finds descendant pids of a process tree', () => {
    const { topPid, allPids } = spawnTree();
    allSpawned.push(...allPids);
    const descendants = listDescendants(topPid);
    expect(descendants.length).toBeGreaterThanOrEqual(2);
    // All descendants should be in the allPids set.
    for (const d of descendants) {
      expect(allPids).toContain(d);
    }
  });

  it('returns empty for a leaf process', () => {
    const proc = spawn('sleep', ['30'], {
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();
    const pid = proc.pid!;
    allSpawned.push(pid);
    try {
      const desc = listDescendants(pid);
      expect(desc).toEqual([]);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  });

  it('returns empty for a dead pid', () => {
    const desc = listDescendants(-1);
    expect(desc).toEqual([]);
  });
});

describe('killProcessTree', () => {
  it('kills the entire tree including all descendants', () => {
    const { topPid, allPids } = spawnTree();
    allSpawned.push(...allPids);

    killProcessTree(topPid, 'SIGKILL');

    // Poll up to 1s: all pids should be dead.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const alive = allPids.filter(isAlive);
      if (alive.length === 0) break;
      spawnSync('sleep', ['0.02']);
    }
    for (const p of allPids) {
      expect(isAlive(p)).toBe(false);
    }
  });

  it('no-ops for pid <= 0', () => {
    killProcessTree(0, 'SIGKILL');
    killProcessTree(-1, 'SIGKILL');
    // No throw = pass.
  });
});
