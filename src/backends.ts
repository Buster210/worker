import { readFileSync } from 'fs';

export type Backend = 'pool' | 'pi' | 'opencode' | 'cmd' | 'claude' | 'claude_tmux';

export const LADDER: Backend[] = (
  ['pool', 'pi', 'opencode', 'cmd', 'claude', 'claude_tmux'] as Backend[]
).filter(be => process.env[`SKIP_${be}`] !== '1');

const STANDARDS = `You are a coding worker. BINDING STANDARDS: priority correctness > security > clarity > performance > brevity. Make surgical, minimal changes — touch only what the task needs, no drive-by refactors. When changing code that already works, stay behaviorally lossless. Validate inputs at trust boundaries; never put secrets in code or logs. Match the surrounding code conventions; idiomatic to the language; prefer stdlib/maintained deps over hand-rolling.`;
const CONTRACT = `\nMake only the changes the task requires. Stop when done. Final reply = ONE line: "DONE" or "FAILED:<reason>". Nothing else.`;

export function buildSpec(backend: Backend, userPrompt: string): string {
  if (backend === 'claude' || backend === 'claude_tmux') {
    return `${userPrompt}${CONTRACT}`;
  }
  return `${STANDARDS}\n\n${userPrompt}${CONTRACT}`;
}

export function buildRunArgv(backend: Backend, spec: string, repo: string, sid: string, model?: string, provider?: string): string[] {
  switch (backend) {
    case 'claude':
      return ['claude', '-p', spec, '--session-id', sid, '--model', 'sonnet', '--dangerously-skip-permissions', '--add-dir', repo];
    case 'pi': {
      const prov = provider ?? process.env.PI_PROVIDER ?? 'google';
      return ['pi', '-p', spec, '--session-id', sid, '--provider', prov, ...(model ? ['--model', model] : [])];
    }
    case 'cmd':
      return ['cmd', '-p', spec, '--yolo', '--skip-onboarding', '--add-dir', repo, ...(model ? ['--model', model] : [])];
    case 'opencode':
      return ['opencode', 'run', spec, '--dir', repo, '--dangerously-skip-permissions', ...(model ? ['-m', model] : [])];
    case 'pool':
      return ['pool', 'exec', '-p', spec, '-d', repo, '--unsafe-auto-allow'];
    default:
      throw new Error(`Unknown backend: ${backend}`);
  }
}

export function buildResumeArgv(backend: Backend, spec: string, repo: string, token: string, model?: string, provider?: string): string[] {
  switch (backend) {
    case 'claude':
      return ['claude', '-p', spec, '--resume', token, '--model', 'sonnet', '--dangerously-skip-permissions', '--add-dir', repo];
    case 'pi': {
      const prov = provider ?? process.env.PI_PROVIDER ?? 'google';
      return ['pi', '-p', spec, '--session-id', token, '--provider', prov];
    }
    case 'opencode':
      return ['opencode', 'run', spec, '-s', token, '--dir', repo];
    case 'pool':
      return ['pool', 'exec', '-p', spec, '-d', repo, '--unsafe-auto-allow', '--continue', token];
    case 'cmd':
      return ['cmd', '-p', spec, '--yolo', '--skip-onboarding', '--add-dir', repo, ...(model ? ['--model', model] : [])];
    default:
      throw new Error(`Unknown backend: ${backend}`);
  }
}

export function getResumeToken(backend: Backend, sid: string, logPath: string): string {
  switch (backend) {
    case 'claude': case 'pi': return sid;
    case 'pool': return 'last';
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
