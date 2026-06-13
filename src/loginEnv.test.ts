import { describe, test, expect } from 'bun:test';
import { parseEnvSnapshot, loginShellEnv } from './env.ts';
import { spawnSync } from 'child_process';
import { writeFileSync, chmodSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const MARKER = '__WORKER_ENV_a7f3__';

describe('parseEnvSnapshot', () => {
  test('banner before marker is discarded, JSON after marker is parsed', () => {
    const banner = 'Welcome to zsh on macOS\nLast login: Mon Jun 17 10:00:00\n';
    const env = { HOME: '/Users/test', PATH: '/usr/bin:/bin', MY_SECRET: 'abc123' };
    const stdout = banner + MARKER + '\n' + JSON.stringify(env);
    const result = parseEnvSnapshot(stdout, MARKER);
    expect(result).toEqual(env);
  });

  test('marker not found → null', () => {
    const result = parseEnvSnapshot('some random output without marker', MARKER);
    expect(result).toBeNull();
  });

  test('marker found but no JSON after it → null', () => {
    const result = parseEnvSnapshot(MARKER + '\nno json here\n', MARKER);
    expect(result).toBeNull();
  });

  test('malformed JSON after marker → null', () => {
    const result = parseEnvSnapshot(MARKER + '\n{not valid json', MARKER);
    expect(result).toBeNull();
  });

  test('empty env object is valid', () => {
    const result = parseEnvSnapshot(MARKER + '\n' + JSON.stringify({}), MARKER);
    expect(result).toEqual({});
  });

  test('banner with special chars before marker does not corrupt parse', () => {
    const banner = 'fastfetch output\n\x1b[32mColors!\x1b[0m\n$(echo injected)\n';
    const env = { FOO: 'bar' };
    const result = parseEnvSnapshot(banner + MARKER + JSON.stringify(env), MARKER);
    expect(result).toEqual(env);
  });
});

describe('loginShellEnv with a fake shell', () => {
  test('captures env from fake login shell, banner discarded', () => {
    const dir = join(tmpdir(), `worker-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    const fakeShell = join(dir, 'fake-shell.sh');
    const customVar = `LOGIN_TEST_${Date.now()}`;
    // Fake shell: emit a banner, then marker + env JSON
    writeFileSync(fakeShell, [
      '#!/bin/sh',
      'echo "Welcome to my shell"',
      'echo "Last login: never"',
      `printf '%s\\n' '${MARKER}'`,
      `exec '${process.execPath}' -e 'var e=Object.assign({},process.env);e.${customVar}="captured";process.stdout.write(JSON.stringify(e))'`,
    ].join('\n'));
    chmodSync(fakeShell, 0o755);

    // Run a login shell (-l -c) through the fake shell — same snippet loginShellEnv uses
    const snippet =
      `printf '%s\\n' '${MARKER}'; exec "${process.execPath}" -e 'var e=Object.assign({},process.env);e.${customVar}="captured";process.stdout.write(JSON.stringify(e))'`;
    const result = spawnSync(fakeShell, ['-l', '-c', snippet], { encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(0);

    const parsed = parseEnvSnapshot(result.stdout, MARKER);
    expect(parsed).not.toBeNull();
    expect(parsed![customVar]).toBe('captured');
    // Banner text should not be inside the parsed env values
    expect(parsed!['Welcome to my shell']).toBeUndefined();
  });
});

describe('loginShellEnv opt-out', () => {
  test('WORKER_LOGIN_SHELL=0 → loginShellEnv() returns null without spawning a shell', () => {
    const prev = process.env.WORKER_LOGIN_SHELL;
    process.env.WORKER_LOGIN_SHELL = '0';
    try {
      // Opt-out is checked before the memo cache, so this holds regardless of prior calls.
      expect(loginShellEnv()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.WORKER_LOGIN_SHELL;
      else process.env.WORKER_LOGIN_SHELL = prev;
    }
  });
});
