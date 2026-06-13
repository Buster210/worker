import { describe, it, expect, test, beforeEach, afterEach } from 'bun:test';
import { buildSpec, buildRunArgv, buildResumeArgv, getResumeToken, emitsJsonLog, computeLadder, ALL_BACKENDS, type Backend } from './backends.ts';
import { handleDir } from './state.ts';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

describe('buildSpec', () => {
  it('returns prompt with CONTRACT for claude', () => {
    const spec = buildSpec('claude', 'test prompt');
    expect(spec).toContain('test prompt');
    expect(spec).toContain('DONE');
  });

  it('returns prompt without STANDARDS for codex', () => {
    const spec = buildSpec('codex', 'test prompt');
    expect(spec).toContain('test prompt');
    expect(spec).toContain('DONE');
    expect(spec).not.toContain('BINDING STANDARDS');
  });

  it('returns prompt with standards and CONTRACT for non-claude', () => {
    const spec = buildSpec('cmd', 'test prompt');
    expect(spec).toContain('test prompt');
    expect(spec).toContain('BINDING STANDARDS');
    expect(spec).toContain('DONE');
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
    expect(argv).toEqual(['omp', '-p', 'spec', '--session-dir', handleDir('sid123', '/repo'), '--approval-mode=yolo', '--mode=json']);
    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('--provider');
  });

  it('builds cmd argv without model if not provided', () => {
    const argv = buildRunArgv('cmd', 'spec', '/repo', 'sid123');
    expect(argv).toEqual(['cmd', '-p', 'spec', '--yolo', '-t', '--skip-onboarding', '--add-dir', '/repo']);
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
    expect(argv).toEqual(['omp', '-p', 'spec', '--session-dir', handleDir('token123', '/repo'), '--continue', '--approval-mode=yolo', '--mode=json']);
  });

  it('builds opencode resume argv with token and skips permissions like run', () => {
    const argv = buildResumeArgv('opencode', 'spec', '/repo', 'token123');
    expect(argv).toEqual(['opencode', 'run', 'spec', '-s', 'token123', '--dir', '/repo', '--dangerously-skip-permissions']);
  });

  it('builds codex resume argv', () => {
    const argv = buildResumeArgv('codex', 'spec', '/repo', 'token123');
    expect(argv).toEqual([
      'codex', 'exec', 'resume', '--last', '--json', '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox', 'spec'
    ]);
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
    expect(emitsJsonLog('claude_tmux')).toBe(false);
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

  it('returns default ALL_BACKENDS when no ladder.json exists', () => {
    const result = computeLadder();
    expect(result).toEqual([...ALL_BACKENDS]);
  });

  it('reorders: ["claude","codex"] puts them first, rest appended', () => {
    writeFileSync(join(tempDir, 'ladder.json'), JSON.stringify(['claude', 'codex']));
    const result = computeLadder();
    const expected: Backend[] = ['claude', 'codex', 'omp', 'opencode', 'pool', 'cmd', 'claude_tmux'];
    expect(result).toEqual(expected);
  });

  it('drops unknown names, keeps valid ones in file order', () => {
    writeFileSync(join(tempDir, 'ladder.json'), JSON.stringify(['bogus', 'omp']));
    const result = computeLadder();
    const expected: Backend[] = ['omp', 'opencode', 'pool', 'cmd', 'codex', 'claude', 'claude_tmux'];
    expect(result).toEqual(expected);
  });

  it('deduplicates: ["omp","omp"] -> single omp', () => {
    writeFileSync(join(tempDir, 'ladder.json'), JSON.stringify(['omp', 'omp']));
    const result = computeLadder();
    const expected: Backend[] = ['omp', 'opencode', 'pool', 'cmd', 'codex', 'claude', 'claude_tmux'];
    expect(result).toEqual(expected);
  });

  it('falls back to default on malformed JSON', () => {
    writeFileSync(join(tempDir, 'ladder.json'), '{bad json');
    const result = computeLadder();
    expect(result).toEqual([...ALL_BACKENDS]);
  });

  it('falls back to default on non-array JSON value', () => {
    writeFileSync(join(tempDir, 'ladder.json'), '{}');
    const result = computeLadder();
    expect(result).toEqual([...ALL_BACKENDS]);
  });

  it('SKIP_pool=1 with reorder file removes pool, keeps order', () => {
    const origSkip = process.env.SKIP_pool;
    process.env.SKIP_pool = '1';
    writeFileSync(join(tempDir, 'ladder.json'), JSON.stringify(['codex', 'omp']));
    try {
      const result = computeLadder();
      const expected: Backend[] = ['codex', 'omp', 'opencode', 'cmd', 'claude', 'claude_tmux'];
      expect(result).toEqual(expected);
    } finally {
      if (origSkip === undefined) delete process.env.SKIP_pool;
      else process.env.SKIP_pool = origSkip;
    }
  });
});
