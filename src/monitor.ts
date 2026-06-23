import { spawnSync } from 'child_process';
import { statSync } from 'fs';

type ActivityMonitor = {
  readonly sig: string;
  readonly log: string;
  readonly at: number;
  readonly repo: string;
  readonly logPath: string;
  dispose: () => void;
};

const _activityMonitors = new Map<string, ActivityMonitor>();

function readLogStat(logPath: string): string {
  try { const st = statSync(logPath); return `${st.mtimeMs}:${st.size}`; } catch { return ''; }
}

// ponytail: poll-on-read, no fs.watch. The watchdog reads sig/at every WORKER_WATCHDOG_MS (5s),
// each read runs poll() -> one statSync. fs.watch on the actively-appended worker log fired a
// callback per write (Bun/macOS kqueue event storm -> a pegged core for the whole run) while the
// watchdog never observes the sub-5s updates anyway. If a backend ever needs finer stall timing,
// shrink WORKER_WATCHDOG_MS rather than re-adding a watcher.
export function activitySig(repo: string, logPath: string, lastLog: string): { sig: string; log: string } {
  const log = readLogStat(logPath);
  if (log !== lastLog) return { sig: log, log };
  const r = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  const git = typeof r.stdout === 'string' ? r.stdout.trim() : '';
  return { sig: `${log}\n${git}`, log };
}

export function startActivityMonitor(repo: string, logPath: string): ActivityMonitor {
  const key = `${repo}\0${logPath}`;
  let cachedLog = readLogStat(logPath);
  let cachedAt = Date.now();
  let lastPollAt = 0;
  const poll = () => {
    if (Date.now() === lastPollAt) return;
    lastPollAt = Date.now();
    const fresh = readLogStat(logPath);
    if (fresh && fresh !== cachedLog) { cachedLog = fresh; cachedAt = Date.now(); }
  };
  const mon: ActivityMonitor = {
    get sig() { poll(); return cachedLog; },
    get log() { return cachedLog; },
    get at() { poll(); return cachedAt; },
    repo,
    logPath,
    dispose() {
      _activityMonitors.delete(key);
    },
  };
  _activityMonitors.set(key, mon);
  return mon;
}

export function __resetActivityMonitors(): void {
  for (const m of _activityMonitors.values()) { try { m.dispose(); } catch {} }
  _activityMonitors.clear();
}
