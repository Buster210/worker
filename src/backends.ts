import { readFileSync } from 'fs';
import { handleDir } from './state.ts';

export type Backend = 'pool' | 'omp' | 'opencode' | 'cmd' | 'claude' | 'claude_tmux' | 'codex';

// All known workers in ladder order. Single source: LADDER is this minus any SKIP_<name>=1,
// the doctor probes this, and worker_run validates against it. Names live in code only —
// never exposed to the MCP client (see server.ts client-facing surfaces).
export const ALL_BACKENDS: readonly Backend[] = ['omp', 'opencode', 'pool', 'cmd', 'codex', 'claude', 'claude_tmux'];

export const LADDER: Backend[] = ALL_BACKENDS.filter(be => process.env[`SKIP_${be}`] !== '1');

const STANDARDS = `You are a coding worker. BINDING STANDARDS: priority correctness > security > clarity > performance > brevity. Make surgical, minimal changes — touch only what the task needs, no drive-by refactors. When changing code that already works, stay behaviorally lossless. Validate inputs at trust boundaries; never put secrets in code or logs. Match the surrounding code conventions; idiomatic to the language; prefer stdlib/maintained deps over hand-rolling.`;
const CONTRACT = `\nMake only the changes the task requires. Stop when done. Final reply = ONE line: "DONE" or "FAILED:<reason>". Nothing else.`;

export function buildSpec(backend: Backend, userPrompt: string): string {
  if (backend === 'claude' || backend === 'claude_tmux' || backend === 'codex') {
    return `${userPrompt}${CONTRACT}`;
  }
  return `${STANDARDS}\n\n${userPrompt}${CONTRACT}`;
}

export function buildRunArgv(backend: Backend, spec: string, repo: string, sid: string, model?: string, extraArgs?: string[]): string[] {
  switch (backend) {
    case 'claude':
      return ['claude', '-p', spec, '--session-id', sid, '--model', 'sonnet', '--dangerously-skip-permissions', '--add-dir', repo, ...(extraArgs ?? [])];
    case 'omp':
      // omp has no pre-assignable session id; pin a per-job session dir so resume is deterministic.
      // --approval-mode=yolo auto-approves tool calls so a fresh/untrusted dir never blocks on a prompt.
      return ['omp', '-p', spec, '--session-dir', handleDir(sid, repo), '--approval-mode=yolo', ...(extraArgs ?? [])];
    case 'cmd':
      return ['cmd', '-p', spec, '--yolo', '-t', '--skip-onboarding', '--add-dir', repo, ...(model ? ['--model', model] : []), ...(extraArgs ?? [])];
    case 'opencode':
      return ['opencode', 'run', spec, '--dir', repo, '--dangerously-skip-permissions', ...(model ? ['-m', model] : []), ...(extraArgs ?? [])];
    case 'pool':
      return ['pool', 'exec', '-p', spec, '-d', repo, '--unsafe-auto-allow', ...(extraArgs ?? [])];
    case 'codex':
      // codex makes its own session id; resume via `exec resume --last` cwd-filtered by spawn cwd.
      // --json streams JSONL events so the log grows continuously — without it codex buffers all
      // output to the end and the runner's stall-watchdog freezes the still-working job at 120s.
      return ['codex', 'exec', '--json', '--cd', repo, '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', ...(model ? ['-m', model] : []), spec];
    default:
      throw new Error(`Unknown backend: ${backend}`);
  }
}

export function buildResumeArgv(backend: Backend, spec: string, repo: string, token: string, model?: string, extraArgs?: string[]): string[] {
  switch (backend) {
    case 'claude':
      return ['claude', '-p', spec, '--resume', token, '--model', 'sonnet', '--dangerously-skip-permissions', '--add-dir', repo, ...(extraArgs ?? [])];
    case 'omp':
      // token is the original handle → same per-job session dir as the run; --continue resumes it.
      return ['omp', '-p', spec, '--session-dir', handleDir(token, repo), '--continue', '--approval-mode=yolo', ...(extraArgs ?? [])];
    case 'opencode':
      return ['opencode', 'run', spec, '-s', token, '--dir', repo, ...(extraArgs ?? [])];
    case 'pool':
      return ['pool', 'exec', '-p', spec, '-d', repo, '--unsafe-auto-allow', '--continue', token, ...(extraArgs ?? [])];
    case 'cmd':
      return ['cmd', '-p', spec, '--yolo', '-t', '--skip-onboarding', '--add-dir', repo, ...(model ? ['--model', model] : []), ...(extraArgs ?? [])];
    case 'codex':
      // `exec resume` has no --cd, relies on spawn cwd; always resumes last session.
      // --json: stream events so the log keeps growing (see buildRunArgv) — avoids a false stall.
      return ['codex', 'exec', 'resume', '--last', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', ...(model ? ['-m', model] : []), spec];
    default:
      throw new Error(`Unknown backend: ${backend}`);
  }
}

export function getResumeToken(backend: Backend, sid: string, logPath: string): string {
  switch (backend) {
    case 'claude': case 'omp': return sid;
    case 'pool': case 'codex': return 'last';
    case 'opencode': {
      try {
        const log = readFileSync(logPath, 'utf8');
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
