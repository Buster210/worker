import { describe, it, expect, afterAll, spyOn } from 'bun:test';
import { spawnSync, spawn } from 'child_process';
import * as childProcess from 'child_process';
import { listDescendants, killProcessTree, killProcessTrees } from '../src/process.ts'


function spawnTree(): { topPid: number; allPids: number[] } {
  
  const script = 'sleep 30 & exec sleep 30'; 
  
  const fullScript = [
    'sleep 30 &',          
    'sleep 30 &',          
    'exec sleep 30',       
  ].join(' ');
  const proc = spawn('bash', ['-c', fullScript], {
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  const topPid = proc.pid!;

  
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
  
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
  const stat = ps.stdout?.toString().trim() ?? '';
  return !stat.startsWith('Z');
}

const allSpawned: number[] = [];

afterAll(() => {
  
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

  it('skips malformed ps output lines (no crash, no false pids)', () => {
    
    
    const psSpy = spyOn(childProcess, 'spawnSync').mockReturnValue({
      stdout: `123 bogus\n789 1\n`, 
      status: 0,
      signal: null,
      pid: 0,
      output: [],
      stderr: '',
    } as any);
    try {
      const desc = listDescendants(1);
      
      expect(desc).toEqual([789]);
    } finally {
      psSpy.mockRestore();
    }
  });
});

describe('killProcessTree', () => {
  it('kills the entire tree including all descendants', () => {
    const { topPid, allPids } = spawnTree();
    allSpawned.push(...allPids);

    killProcessTree(topPid, 'SIGKILL');

    
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
    
  });
});

describe('killProcessTrees (batch)', () => {
  it('kills multiple trees from a single snapshot', () => {
    const a = spawnTree();
    const b = spawnTree();
    allSpawned.push(...a.allPids, ...b.allPids);

    killProcessTrees([a.topPid, b.topPid], 'SIGKILL');

    const all = [...a.allPids, ...b.allPids];
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (all.filter(isAlive).length === 0) break;
      spawnSync('sleep', ['0.02']);
    }
    for (const p of all) expect(isAlive(p)).toBe(false);
  });

  it('no-ops for empty or non-positive pids', () => {
    killProcessTrees([], 'SIGKILL');
    killProcessTrees([0, -1], 'SIGKILL');
    
  });

  
  it('enumerates once per pass for N trees (not per pid)', () => {
    const P1 = 999991, C1 = 888881, P2 = 999992, C2 = 888882;
    const order: string[] = [];
    const psSpy = spyOn(childProcess, 'spawnSync').mockImplementation((cmd: any) => {
      if (cmd === 'ps') {
        order.push('enumerate');
        return { stdout: `${C1} ${P1}\n${C2} ${P2}\n`, status: 0, signal: null, pid: 0, output: [], stderr: '' } as any;
      }
      return { stdout: '', status: 0, signal: null, pid: 0, output: [], stderr: '' } as any;
    });
    const killSpy = spyOn(process, 'kill').mockImplementation((() => true) as any);
    try {
      killProcessTrees([P1, P2], 'SIGKILL');
      
      expect(order).toEqual(['enumerate', 'enumerate']);
    } finally {
      psSpy.mockRestore();
      killSpy.mockRestore();
    }
  });

  
  it('enumerates descendants BEFORE killing the group (no reparent leak)', () => {
    const FAKE = 999999;
    const CHILD = 888888;
    const order: string[] = [];

    const psSpy = spyOn(childProcess, 'spawnSync').mockImplementation((cmd: any) => {
      if (cmd === 'ps') {
        order.push('enumerate');
        return { stdout: `${CHILD} ${FAKE}\n`, status: 0, signal: null, pid: 0, output: [], stderr: '' } as any;
      }
      return { stdout: '', status: 0, signal: null, pid: 0, output: [], stderr: '' } as any;
    });
    const killSpy = spyOn(process, 'kill').mockImplementation(((p: number) => {
      if (p === -FAKE) order.push('killgroup');
      else if (p === CHILD) order.push('killchild');
      return true;
    }) as any);

    try {
      killProcessTree(FAKE, 'SIGKILL');
      
      
      expect(order).toEqual(['enumerate', 'killgroup', 'killchild', 'enumerate', 'killchild']);
    } finally {
      psSpy.mockRestore();
      killSpy.mockRestore();
    }
  });
});
