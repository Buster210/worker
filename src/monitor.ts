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
export function startActivityMonitor(repo: string, logPath: string): ActivityMonitor {
  const key = `${repo}\0${logPath}`;
  let watcher: FSWatcher | undefined;
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
      try { watcher?.close(); } catch {}
      _activityMonitors.delete(key);
    },
  };
  try {
    watcher = fsWatch(logPath, { persistent: false }, () => {
      const fresh = readLogStat(logPath);
      if (fresh && fresh !== cachedLog) {
        cachedLog = fresh;
        cachedAt = Date.now();
      }
    });
  } catch {}
  _activityMonitors.set(key, mon);
  return mon;
}

export function __resetActivityMonitors(): void {
  for (const m of _activityMonitors.values()) { try { m.dispose(); } catch {} }
  _activityMonitors.clear();
}
