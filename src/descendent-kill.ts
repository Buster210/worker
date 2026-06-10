import { spawnSync } from 'child_process';

/**
 * Recursively collect all descendant pids of `pid` using `pgrep -P <pid>`,
 * depth-first. Does NOT include `pid` itself. Robust to no children / pgrep
 * failure — returns whatever was found, never throws.
 */
export function listDescendants(pid: number): number[] {
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
      if (child > 0) {
        result.push(child);
        stack.push(child);
      }
    }
  }
  return result;
}

/**
 * Kill the whole process tree rooted at `pid`: first signal the negative-pid
 * process group (the way the existing code does), then individually kill every
 * descendant pid (catches descendants that re-grouped into a new process group).
 *
 * Order: collect descendants BEFORE killing (snapshot while alive), then kill
 * group, then kill each leftover descendant individually.
 *
 * Guards pid <= 0 as a no-op. Wraps every kill in try/catch (ESRCH = already dead).
 */
export function killProcessTree(pid: number, sig: NodeJS.Signals | number = 'SIGKILL'): void {
  if (pid <= 0) return;

  // Snapshot descendants while they're still alive.
  const descendants = listDescendants(pid);

  // Kill the original process group (the standard path).
  try { process.kill(-pid, sig); } catch {}

  // Kill every descendant individually — catches those that escaped the group kill.
  for (const child of descendants) {
    try { process.kill(child, sig); } catch {}
  }
}
