import { handleDir } from './state.ts';
import { tailCapped } from './logParse.ts';

export type Backend = 'pool' | 'omp' | 'opencode' | 'cmd' | 'claude' | 'claude_tmux' | 'codex';

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
      return ['omp', '-p', spec, '--session-dir', handleDir(sid, repo), '--approval-mode=yolo', '--mode=json', ...(extraArgs ?? [])];
    case 'cmd':
      return ['cmd', '-p', spec, '--yolo', '-t', '--skip-onboarding', '--add-dir', repo, ...(model ? ['--model', model] : []), ...(extraArgs ?? [])];
    case 'opencode':
      return ['opencode', 'run', spec, '--dir', repo, '--dangerously-skip-permissions', '--format', 'json', ...(model ? ['-m', model] : []), ...(extraArgs ?? [])];
    case 'pool':
      return ['pool', 'exec', '-p', spec, '-d', repo, '--unsafe-auto-allow', ...(extraArgs ?? [])];
    case 'codex':
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
      return ['omp', '-p', spec, '--session-dir', handleDir(token, repo), '--continue', '--approval-mode=yolo', '--mode=json', ...(extraArgs ?? [])];
    case 'opencode':
      return ['opencode', 'run', spec, '-s', token, '--dir', repo, '--dangerously-skip-permissions', ...(extraArgs ?? [])];
    case 'pool':
      return ['pool', 'exec', '-p', spec, '-d', repo, '--unsafe-auto-allow', '--continue', token, ...(extraArgs ?? [])];
    case 'cmd':
      return ['cmd', '-p', spec, '--yolo', '-t', '--skip-onboarding', '--add-dir', repo, ...(model ? ['--model', model] : []), ...(extraArgs ?? [])];
    case 'codex':
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
