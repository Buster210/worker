import { handleDirUncached, workersDir } from './state.ts';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { tailCapped } from './logParse.ts';
import { FILE_CONFIG, type FileConfig } from './config.ts';
import { authProbeMs, maxTurns } from './env.ts';

export type Backend = 'pool' | 'omp' | 'opencode' | 'cmd' | 'claude' | 'claude_tmux' | 'codex';

export const ALL_BACKENDS: readonly Backend[] = ['codex', 'cmd', 'pool', 'omp', 'opencode', 'claude', 'claude_tmux'];

// Quiet backends do NOT emit thinking/reasoning to the log, so long silent gaps are normal work,
// not a stall — they get a longer stall timeout (env.ts quietStallMs). Membership is hardcoded:
// there is no runtime signal for "emits thinking", so it must be declared per known backend.
export const QUIET_BACKENDS: ReadonlySet<Backend> = new Set<Backend>(['codex']);

// Check for legacy ladder.json and warn once
let _ladderJsonWarned = false;
function checkLegacyLadder(): void {
  if (_ladderJsonWarned) return;
  if (existsSync(join(workersDir(), 'ladder.json'))) {
    console.error('[config] Legacy ladder.json found. Move its contents to config.json ladder/skip keys.');
    _ladderJsonWarned = true;
  }
}
// Auth probe for the two metered backends. Returns true = keep in ladder.
// exit 0 = authed. exit != 0 = unauthenticated -> drop. ENOENT (not installed) -> drop.
// any other spawn error (timeout, etc.) -> fail-open (keep) so a flaky probe never
// kills a working backend.
function probeAuth(be: 'cmd' | 'codex'): boolean {
  const argv = be === 'cmd' ? ['cmd', 'status'] : ['codex', 'login', 'status'];
  const r = spawnSync(argv[0], argv.slice(1), {
    timeout: authProbeMs(),
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (r.error) return (r.error as NodeJS.ErrnoException).code !== 'ENOENT'; // missing -> drop; transient -> keep
  return r.status === 0;
}

// Default auth check used by the live LADDER. Short-circuits to true (skip probing)
// when WORKER_SKIP_AUTH_GATE=1 (tests + ops kill-switch). Only cmd/codex are probed.
function defaultIsAuthed(be: Backend): boolean {
  if (process.env.WORKER_SKIP_AUTH_GATE === '1') return true;
  if (be !== 'cmd' && be !== 'codex') return true;
  return probeAuth(be);
}

export function computeLadder(
  cfgOrIsAuthed: FileConfig | ((be: Backend) => boolean) = FILE_CONFIG,
): Backend[] {
  checkLegacyLadder();
  const isAuthed: (be: Backend) => boolean =
    typeof cfgOrIsAuthed === 'function' ? cfgOrIsAuthed : defaultIsAuthed;
  const cfg: FileConfig =
    typeof cfgOrIsAuthed === 'function' ? FILE_CONFIG : cfgOrIsAuthed;
  const validSet = new Set<string>(ALL_BACKENDS);
  // Build skip set: union of env SKIP_<be>='1' and cfg.skip
  const skipSet = new Set<string>();
  for (const be of ALL_BACKENDS) {
    if (process.env[`SKIP_${be}`] === '1') skipSet.add(be);
  }
  for (const be of cfg.skip ?? []) {
    if (typeof be === 'string' && validSet.has(be)) skipSet.add(be);
  }

  const keep = (be: Backend) => !skipSet.has(be) && ((be !== 'cmd' && be !== 'codex') || isAuthed(be));
  const defaultOrder: Backend[] = ALL_BACKENDS.filter(keep);

  const raw = cfg.ladder;

  if (!Array.isArray(raw)) {
    return defaultOrder;
  }

  const seen = new Set<string>();
  const ordered: Backend[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    if (!validSet.has(entry)) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    ordered.push(entry as Backend);
  }

  for (const be of ALL_BACKENDS) {
    if (!seen.has(be)) ordered.push(be);
  }

  return ordered.filter(keep);
}

export const LADDER: Backend[] = computeLadder();

const PREAMBLE = `You are a senior coding worker. Deliver mature, pragmatic, production-grade code. Work in order: (1) understand the task; touch only what it requires. (2) Plan in place only; do NOT enter plan mode. Take the laziest solution that works — does it need to exist (YAGNI)? → stdlib → native feature → already-installed dep → one line → minimal code; stop at the first rung that holds. No speculative abstraction, no boilerplate-for-later; deletion over addition; shortest working diff. (3) Implement. (4) Test, run, and verify. (5) Review the result against every requirement in the spec and confirm the deliverables exist as saved files. Only then signal DONE; otherwise FAILED:<reason>. Do NOT commit — the harness makes the atomic commit on green. Priorities: correctness > security > clarity > performance > brevity. Full standards: ~/.claude/skills/coding-standards/SKILL.md.`;
const CONTRACT = `\nMake only the changes the task requires. Stop when done. Final reply = ONE line: "DONE" or "FAILED:<reason>". Nothing else.`;

export function buildSpec(backend: Backend, userPrompt: string): string {
  void backend;
  return `${PREAMBLE}\n\n${userPrompt}${CONTRACT}`;
}

export function buildRunArgv(backend: Backend, spec: string, repo: string, sid: string, model?: string, extraArgs?: string[]): string[] {
  switch (backend) {
    case 'claude':
      return ['claude', '-p', spec, '--session-id', sid, '--model', model ?? 'sonnet', '--dangerously-skip-permissions', '--add-dir', repo, ...(extraArgs ?? [])];
    case 'omp':
      return ['omp', '-p', spec, '--session-dir', handleDirUncached(sid, repo), '--approval-mode=yolo', '--mode=json', ...(extraArgs ?? [])];
    case 'cmd':
      return ['cmd', '-p', spec, '--yolo', '-t', '--skip-onboarding', '--max-turns', String(maxTurns()), '--add-dir', repo, ...(model ? ['--model', model] : []), ...(extraArgs ?? [])];
    case 'opencode':
      return ['opencode', 'run', spec, '--dir', repo, '--dangerously-skip-permissions', '--format', 'json', ...(model ? ['-m', model] : []), ...(extraArgs ?? [])];
    case 'pool':
      return ['pool', 'exec', '-p', spec, '-d', repo, '--unsafe-auto-allow', ...(extraArgs ?? [])];
    case 'codex':
      return ['codex', 'exec', '--json', '--cd', repo, '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', ...(model ? ['-m', model] : []), spec];
    default:
      throw new Error(`Unknown backend: ${backend}. Valid: ${ALL_BACKENDS.join(', ')}`);
  }
}

export function buildResumeArgv(backend: Backend, spec: string, repo: string, token: string, model?: string, extraArgs?: string[]): string[] {
  switch (backend) {
    case 'claude':
      return ['claude', '-p', spec, '--resume', token, '--model', model ?? 'sonnet', '--dangerously-skip-permissions', '--add-dir', repo, ...(extraArgs ?? [])];
    case 'omp':
      return ['omp', '-p', spec, '--session-dir', handleDirUncached(token, repo), '--continue', '--approval-mode=yolo', '--mode=json', ...(extraArgs ?? [])];
    case 'opencode':
      return ['opencode', 'run', spec, '-s', token, '--dir', repo, '--dangerously-skip-permissions', '--format', 'json', ...(extraArgs ?? [])];
    case 'pool':
      return ['pool', 'exec', '-p', spec, '-d', repo, '--unsafe-auto-allow', '--continue', token, ...(extraArgs ?? [])];
    case 'cmd':
      return ['cmd', '-p', spec, '--yolo', '-t', '--skip-onboarding', '--max-turns', String(maxTurns()), '--add-dir', repo, ...(model ? ['--model', model] : []), ...(extraArgs ?? [])];
    case 'codex':
      return ['codex', 'exec', 'resume', '--last', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', ...(model ? ['-m', model] : []), spec];
    default:
      throw new Error(`Unknown backend: ${backend}. Valid: ${ALL_BACKENDS.join(', ')}`);
  }
}

export function getResumeToken(backend: Backend, sid: string, logPath: string): string {
  switch (backend) {
    case 'claude': case 'omp': return sid;
    case 'pool': case 'codex': return 'last';
    case 'opencode': {
      try {
        const log = tailCapped(logPath, 65_536);
        const matches = log.match(/ses_[A-Za-z0-9]+/g);
        const lastMatch = matches?.[matches.length - 1] ?? '';
        if (!lastMatch && log.trim().length > 0) {
          console.error('[opencode] No session token found in log for resume');
        }
        return lastMatch;
      } catch { return ''; }
    }
    default: return '';
  }
}
export function emitsJsonLog(backend: string): boolean { return backend === 'omp' || backend === 'codex' || backend === 'pool'; }
