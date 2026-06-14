import { spawnSync, execSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, realpathSync, existsSync, copyFileSync, renameSync } from 'fs';
import { updateJob, finalizeJob, workersDir, logPath as workerLogPath } from './state.ts';
import { resolveStatus } from './status.ts';
import { defaultTimeoutMs, workerEnv } from './env.ts';
import { type RunResult } from './runner.ts';

type TrustEntry = { hasTrustDialogAccepted?: boolean; hasCompletedProjectOnboarding?: boolean; projectOnboardingSeenCount?: number; [k: string]: unknown };
type ClaudeConfig = { projects?: Record<string, TrustEntry>; [k: string]: unknown };

const CLAUDE_CFG = `${process.env.HOME}/.claude.json`;
const CLAUDE_CFG_BAK = `${CLAUDE_CFG}.worker-bak`;

const _seededTrustKeys = new Set<string>();

function seedRepoTrust(repo: string): void {
  const real = (() => { try { return realpathSync(repo); } catch { return repo; } })();
  const key = `${repo}\0${real}`;
  if (_seededTrustKeys.has(key)) return;
  _seededTrustKeys.add(key);

  let cfg: ClaudeConfig;
  try { cfg = JSON.parse(readFileSync(CLAUDE_CFG, 'utf8')); }
  catch { return; }

  const projects = cfg.projects ?? (cfg.projects = {});
  const keys = [...new Set([repo, real])];

  if (keys.every(k => projects[k]?.hasTrustDialogAccepted === true)) return;

  if (!existsSync(CLAUDE_CFG_BAK)) {
    try { copyFileSync(CLAUDE_CFG, CLAUDE_CFG_BAK); } catch {}
  }

  for (const key of keys) {
    projects[key] = {
      ...projects[key],
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
      projectOnboardingSeenCount: projects[key]?.projectOnboardingSeenCount ?? 1,
    };
  }

  const tmp = `${CLAUDE_CFG}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    renameSync(tmp, CLAUDE_CFG);
  } catch {
    try { unlinkSync(tmp); } catch {}
  }
}

export async function runClaudeTmux(
  spec: string,
  repo: string,
  handle: string,
  sid: string,
  timeoutMs: number = defaultTimeoutMs(),
): Promise<RunResult> {
  try { execSync('which tmux', { stdio: 'ignore' }); }
  catch { throw new Error('claude_tmux backend requires tmux'); }

  const wdir = `${workersDir()}/tmux`;
  mkdirSync(wdir, { recursive: true });

  const settingsFile = `${wdir}/${sid}.settings.json`;
  const doneFile     = `${wdir}/${sid}.done`;
  const specFile     = `${wdir}/${sid}.spec`;
  const launchScript = `${wdir}/${sid}.launch.sh`;
  const logPath = workerLogPath(handle);

  seedRepoTrust(repo);

  writeFileSync(settingsFile, JSON.stringify({
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `printf 'stop\\n' >> '${doneFile}'` }] }] }
  }));
  writeFileSync(specFile, spec);
  writeFileSync(doneFile, '');
  writeFileSync(launchScript, `#!/usr/bin/env bash\nexec claude --settings "${settingsFile}" --dangerously-skip-permissions --model sonnet "$(cat "${specFile}")"`, { mode: 0o755 });

  try { execSync(`tmux kill-session -t ${sid} 2>/dev/null`, { stdio: 'ignore' }); } catch {}

  const tmuxSpawn = spawnSync('tmux', ['new-session', '-d', '-s', sid, '-x', '220', '-y', '50', '-c', repo, `bash "${launchScript}"`], {
    env: workerEnv, encoding: 'utf8',
  });

  if (tmuxSpawn.status !== 0) {
    finalizeJob(handle, 'failed');
    return { status: 'failed', exit_code: 1, backend: 'claude_tmux', handle, resume_token: '', repo, log: logPath };
  }

  updateJob(handle, { worker_pid: 0 });

  const deadline = Date.now() + timeoutMs;
  let stopped = false;

  while (Date.now() < deadline) {
    try {
      const content = readFileSync(doneFile, 'utf8');
      if (content.trim().length > 0) { stopped = true; break; }
    } catch {}
    try { execSync(`tmux has-session -t ${sid} 2>/dev/null`, { stdio: 'ignore' }); }
    catch { stopped = true; break; }
    await Bun.sleep(1000);
  }

  try {
    const pane = execSync(`tmux capture-pane -t ${sid} -p -S -5000 2>/dev/null`, { encoding: 'utf8', env: workerEnv });
    writeFileSync(logPath, pane);
  } catch {}

  try { execSync(`tmux kill-session -t ${sid} 2>/dev/null`, { stdio: 'ignore' }); } catch {}
  for (const f of [settingsFile, specFile, launchScript, doneFile]) { try { unlinkSync(f); } catch {} }

  const timedOut = !stopped;
  const status = finalizeJob(handle, resolveStatus('claude_tmux', 0, logPath, timedOut));

  return { status, exit_code: timedOut ? 124 : 0, backend: 'claude_tmux', handle, resume_token: '', repo, log: logPath };
}
