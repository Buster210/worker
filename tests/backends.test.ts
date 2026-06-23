import { describe, it, expect, test, beforeEach, afterEach } from 'bun:test';
import { buildSpec, buildRunArgv, buildResumeArgv, getResumeToken, emitsJsonLog, computeLadder, ALL_BACKENDS, QUIET_BACKENDS, type Backend } from '../src/backends.ts';
import { stallTimeoutMs, quietStallMs } from '../src/env.ts';
import { handleDirUncached } from '../src/state.ts';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

describe('buildSpec', () => {
  it('wraps prompt with PREAMBLE and CONTRACT for non-claude backend (cmd)', () => {
    const spec = buildSpec('test prompt');
    expect(spec).toContain('test prompt');
    expect(spec).toContain('senior coding worker');
    expect(spec).toContain('DONE');
    expect(spec.startsWith('You are a senior coding worker.')).toBe(true);
    expect(spec.endsWith('Nothing else.')).toBe(true);
  });

  it('wraps prompt with PREAMBLE and CONTRACT for claude backend', () => {
    const spec = buildSpec('test prompt');
    expect(spec).toContain('test prompt');
    expect(spec).toContain('senior coding worker');
    expect(spec).toContain('DONE');
    expect(spec.startsWith('You are a senior coding worker.')).toBe(true);
    expect(spec.endsWith('Nothing else.')).toBe(true);
  });

  it('wraps prompt with PREAMBLE and CONTRACT for codex backend', () => {
    const spec = buildSpec('test prompt');
    expect(spec).toContain('test prompt');
    expect(spec).toContain('senior coding worker');
    expect(spec).toContain('DONE');
    expect(spec.startsWith('You are a senior coding worker.')).toBe(true);
    expect(spec.endsWith('Nothing else.')).toBe(true);
  });

  it('all backends produce identical structure (preamble + task + contract)', () => {
    const backends: Backend[] = ['codex', 'cmd', 'pool', 'omp', 'opencode', 'claude'];
    const specs = backends.map(() => buildSpec('my task'));
    
    for (const spec of specs) {
      expect(spec).toBe(specs[0]);
    }
  });

  it('PREAMBLE step-5 tells the agent NOT to commit (harness owns the commit)', () => {
    const spec = buildSpec('my task');
    expect(spec).toContain('Do NOT commit');
    expect(spec).toContain('harness makes the atomic commit on green');
    
    expect(spec).not.toContain('make ONE atomic commit only when all green');
  });
});

describe('buildRunArgv', () => {
  it('builds claude argv with sonnet pinned', () => {
    const argv = buildRunArgv('claude', 'spec', '/repo', 'sid123');
    expect(argv).toEqual([
      'claude', '-p', 'spec', '--session-id', 'sid123', '--model', 'sonnet',
      '--dangerously-skip-permissions', '--add-dir', '/repo'
    ]);
  });

  it('builds omp argv with a per-job session dir and no model/provider', () => {
    const argv = buildRunArgv('omp', 'spec', '/repo', 'sid123');
    expect(argv).toEqual(['omp', '-p', 'spec', '--session-dir', handleDirUncached('sid123', '/repo'), '--approval-mode=yolo', '--mode=json']);
    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('--provider');
  });

  it('builds cmd argv without model if not provided', () => {
    const argv = buildRunArgv('cmd', 'spec', '/repo', 'sid123');
    expect(argv).toEqual(['cmd', '-p', 'spec', '--yolo', '-t', '--skip-onboarding', '--max-turns', '10000', '--add-dir', '/repo']);
  });

  it('builds opencode argv with optional model', () => {
    const argv = buildRunArgv('opencode', 'spec', '/repo', 'sid123', 'gpt-4');
    expect(argv).toContain('-m');
    expect(argv).toContain('gpt-4');
  });

  it('builds pool argv', () => {
    const argv = buildRunArgv('pool', 'spec', '/repo', 'sid123');
    expect(argv).toEqual(['pool', 'exec', '-p', 'spec', '-d', '/repo', '--unsafe-auto-allow']);
  });

  it('builds codex argv', () => {
    const argv = buildRunArgv('codex', 'spec', '/repo', 'sid123');
    expect(argv).toEqual([
      'codex', 'exec', '--json', '--cd', '/repo', '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox', 'spec'
    ]);
  });

  it('builds codex argv with model', () => {
    const argv = buildRunArgv('codex', 'spec', '/repo', 'sid123', 'o4-mini');
    expect(argv).toContain('-m');
    expect(argv).toContain('o4-mini');
    expect(argv[argv.length - 1]).toBe('spec');
  });

  it('throws for unknown backend and lists valid backends', () => {
    expect(() => buildRunArgv('bogus' as Backend, 'spec', '/repo', 'sid'))
      .toThrow(`Unknown backend: bogus. Valid: ${ALL_BACKENDS.join(', ')}`);
  });
});

describe('buildResumeArgv', () => {
  it('builds claude resume argv with sonnet pinned', () => {
    const argv = buildResumeArgv('claude', 'spec', '/repo', 'token123');
    expect(argv).toEqual([
      'claude', '-p', 'spec', '--resume', 'token123', '--model', 'sonnet',
      '--dangerously-skip-permissions', '--add-dir', '/repo'
    ]);
  });

  it('builds omp resume argv with the same session dir plus --continue', () => {
    const argv = buildResumeArgv('omp', 'spec', '/repo', 'token123');
    expect(argv).toEqual(['omp', '-p', 'spec', '--session-dir', handleDirUncached('token123', '/repo'), '--continue', '--approval-mode=yolo', '--mode=json']);
  });

  it('builds opencode resume argv with token and skips permissions like run', () => {
    const argv = buildResumeArgv('opencode', 'spec', '/repo', 'token123');
    expect(argv).toEqual(['opencode', 'run', 'spec', '-s', 'token123', '--dir', '/repo', '--dangerously-skip-permissions', '--format', 'json']);
  });

  it('builds codex resume argv', () => {
    const argv = buildResumeArgv('codex', 'spec', '/repo', 'token123');
    expect(argv).toEqual([
      'codex', 'exec', 'resume', '--last', '--json', '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox', 'spec'
    ]);
  });

  it('builds cmd resume argv with --max-turns at default 10000', () => {
    const argv = buildResumeArgv('cmd', 'spec', '/repo', 'tok');
    const idx = argv.indexOf('--max-turns');
    expect(idx).not.toBe(-1);
    expect(argv[idx + 1]).toBe('10000');
  });

  it('throws for unknown backend and lists valid backends', () => {
    expect(() => buildResumeArgv('bogus' as Backend, 'spec', '/repo', 'token'))
      .toThrow(`Unknown backend: bogus. Valid: ${ALL_BACKENDS.join(', ')}`);
  });
});

describe('getResumeToken', () => {
  it('returns sid for claude', () => {
    const token = getResumeToken('claude', 'my-session-id', '/path/to/log');
    expect(token).toBe('my-session-id');
  });

  it('returns sid for omp', () => {
    const token = getResumeToken('omp', 'my-session-id', '/path/to/log');
    expect(token).toBe('my-session-id');
  });

  it('returns "last" for pool', () => {
    const token = getResumeToken('pool', 'sid', '/path/to/log');
    expect(token).toBe('last');
  });

  it('returns "last" for codex', () => {
    const token = getResumeToken('codex', 'sid', '/path/to/log');
    expect(token).toBe('last');
  });

  it('returns last ses_ match for opencode', () => {
    const logPath = '/tmp/test.log';
    require('fs').writeFileSync(logPath, 'session ses_abc123 started\nmore output\nses_xyz789 done');
    const token = getResumeToken('opencode', 'sid', logPath);
    expect(token).toBe('ses_xyz789');
    require('fs').unlinkSync(logPath);
  });

  it('returns empty string for opencode when no match', () => {
    const logPath = '/tmp/test.log';
    require('fs').writeFileSync(logPath, 'no session token here');
    const token = getResumeToken('opencode', 'sid', logPath);
    expect(token).toBe('');
    require('fs').unlinkSync(logPath);
  });

  it('returns empty string for cmd', () => {
    const token = getResumeToken('cmd', 'sid', '/path/to/log');
    expect(token).toBe('');
  });
});

describe('emitsJsonLog', () => {
  it('omp, codex, and pool emit JSONL', () => {
    expect(emitsJsonLog('omp')).toBe(true);
    expect(emitsJsonLog('codex')).toBe(true);
    expect(emitsJsonLog('pool')).toBe(true);
  });

  it('other backends do not emit JSONL', () => {
    expect(emitsJsonLog('opencode')).toBe(false);
    expect(emitsJsonLog('claude')).toBe(false);
    expect(emitsJsonLog('cmd')).toBe(false);
  });
});

let origStateDir: string | undefined;
let tempDir: string;

function setup() {
  origStateDir = process.env.WORKER_STATE_DIR;
  tempDir = mkdtempSync(join(tmpdir(), 'backends-test-'));
  process.env.WORKER_STATE_DIR = tempDir;
}

function teardown() {
  if (origStateDir === undefined) {
    delete process.env.WORKER_STATE_DIR;
  } else {
    process.env.WORKER_STATE_DIR = origStateDir;
  }
  rmSync(tempDir, { recursive: true, force: true });
}

describe('computeLadder', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns default ALL_BACKENDS when config has no ladder', () => {
    const result = computeLadder({});
    expect(result).toEqual([...ALL_BACKENDS]);
  });

  it('reorders: ["claude","codex"] puts them first, rest appended in ALL_BACKENDS order', () => {
    const result = computeLadder({ ladder: ['claude', 'codex'] });
    const expected: Backend[] = ['claude', 'codex', 'cmd', 'pool', 'omp', 'opencode'];
    expect(result).toEqual(expected);
  });

  it('drops unknown names, keeps valid ones in file order', () => {
    const result = computeLadder({ ladder: ['bogus', 'omp'] });
    const expected: Backend[] = ['omp', 'codex', 'cmd', 'pool', 'opencode', 'claude'];
    expect(result).toEqual(expected);
  });

  it('deduplicates: ["omp","omp"] -> single omp', () => {
    const result = computeLadder({ ladder: ['omp', 'omp'] });
    const expected: Backend[] = ['omp', 'codex', 'cmd', 'pool', 'opencode', 'claude'];
    expect(result).toEqual(expected);
  });

  it('falls back to default when ladder is absent', () => {
    const result = computeLadder({ ladder: undefined });
    expect(result).toEqual([...ALL_BACKENDS]);
  });

  it('SKIP_pool=1 with reorder config removes pool, keeps order', () => {
    const origSkip = process.env.SKIP_pool;
    process.env.SKIP_pool = '1';
    try {
      const result = computeLadder({ ladder: ['codex', 'omp'] });
      const expected: Backend[] = ['codex', 'omp', 'cmd', 'opencode', 'claude'];
      expect(result).toEqual(expected);
    } finally {
      if (origSkip === undefined) delete process.env.SKIP_pool;
      else process.env.SKIP_pool = origSkip;
    }
  });

  it('drops cmd and codex when isAuthed returns false for them', () => {
    const result = computeLadder(() => false);
    
    expect(result).toEqual(['pool', 'omp', 'opencode', 'claude']);
    expect(result).not.toContain('cmd');
    expect(result).not.toContain('codex');
  });

  it('drops only the backend whose auth check fails', () => {
    const result = computeLadder(be => be !== 'codex');
    expect(result).not.toContain('codex');
    expect(result).toContain('cmd');
    expect(result).toEqual(['cmd', 'pool', 'omp', 'opencode', 'claude']);
  });

  it('default isAuthed keeps all backends when WORKER_SKIP_AUTH_GATE=1', () => {
    const orig = process.env.WORKER_SKIP_AUTH_GATE;
    process.env.WORKER_SKIP_AUTH_GATE = '1';
    try {
      expect(computeLadder()).toEqual([...ALL_BACKENDS]);
    } finally {
      if (orig === undefined) delete process.env.WORKER_SKIP_AUTH_GATE;
      else process.env.WORKER_SKIP_AUTH_GATE = orig;
    }
  });
});

describe('QUIET_BACKENDS', () => {
  it('includes codex', () => { expect(QUIET_BACKENDS.has('codex')).toBe(true); });
  it('excludes claude', () => { expect(QUIET_BACKENDS.has('claude')).toBe(false); });
  it('excludes cmd', () => { expect(QUIET_BACKENDS.has('cmd')).toBe(false); });
  it('excludes pool', () => { expect(QUIET_BACKENDS.has('pool')).toBe(false); });
});

describe('stall thresholds', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const keys = ['WORKER_STALL_MS', 'WORKER_STALL_MS_QUIET'] as const;
  beforeEach(() => { for (const k of keys) savedEnv[k] = process.env[k]; });
  afterEach(() => { for (const k of keys) savedEnv[k] === undefined ? delete process.env[k] : process.env[k] = savedEnv[k]; });

  it('stallTimeoutMs defaults to 60_000', () => { expect(stallTimeoutMs()).toBe(60_000); });
  it('quietStallMs defaults to 240_000', () => { expect(quietStallMs()).toBe(240_000); });
  it('WORKER_STALL_MS overrides stallTimeoutMs', () => {
    process.env.WORKER_STALL_MS = '9999';
    expect(stallTimeoutMs()).toBe(9999);
  });
  it('WORKER_STALL_MS_QUIET overrides quietStallMs', () => {
    process.env.WORKER_STALL_MS_QUIET = '42000';
    expect(quietStallMs()).toBe(42000);
  });
});
