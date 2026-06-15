import { spawn, spawnSync } from 'child_process';
import { join } from 'path';
import { handleDir } from './state.ts';

export function addWorktree(repo: string, handle: string): string {
  const path = join(handleDir(handle, repo), 'tree');
  const branch = `worker/${handle}`;
  const r = spawnSync('git', ['-C', repo, 'worktree', 'add', '-b', branch, path, 'HEAD'], { encoding: 'utf8' });
  if (r.error) throw new Error(`worktree add failed for ${handle}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`worktree add failed for ${handle}: ${r.stderr ?? ''}`);
  return path;
}

export async function addWorktreeAsync(repo: string, handle: string): Promise<string> {
  const path = join(handleDir(handle, repo), 'tree');
  const branch = `worker/${handle}`;
  await new Promise<void>((resolve, reject) => {
    const stderr: Buffer[] = [];
    const p = spawn('git', ['-C', repo, 'worktree', 'add', '-b', branch, path, 'HEAD'], { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr?.on('data', (d: Buffer) => stderr.push(d));
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`worktree add failed for ${handle}: ${Buffer.concat(stderr).toString().trim()}`)));
    p.on('error', err => reject(new Error(`worktree add failed for ${handle}: ${err.message}`)));
  });
  return path;
}

export function removeWorktree(repo: string, path: string): void {
  // ponytail: G6 wires reaping — do NOT call from finalizeJob or hot path
  try { spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', path], { encoding: 'utf8' }); } catch {}
  // Best-effort branch deletion: derive handle from the parent dir name of 'tree'
  try {
    const parts = path.split('/');
    const handle = parts[parts.length - 2]; // path = .../workers/<project>/<handle>/tree
    spawnSync('git', ['-C', repo, 'branch', '-D', `worker/${handle}`], { encoding: 'utf8' });
  } catch {}
}

export function listWorktrees(repo: string): string[] {
  const r = spawnSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (r.error || typeof r.stdout !== 'string') return [];
  const paths: string[] = [];
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) paths.push(line.slice('worktree '.length).trim());
  }
  return paths;
}
