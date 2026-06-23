import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadFileConfig } from '../src/config.ts';
import { writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';

let tempDir: string;
let origHome: string | undefined;

describe('loadFileConfig', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'config-test-'));
    origHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty object when file does not exist', () => {
    const config = loadFileConfig(join(tempDir, 'nonexistent.json'));
    expect(config).toEqual({});
  });

  it('returns empty object on malformed JSON', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, '{bad json');
    const config = loadFileConfig(configPath);
    expect(config).toEqual({});
  });

  it('returns empty object on non-object JSON value', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, '"just a string"');
    const config = loadFileConfig(configPath);
    expect(config).toEqual({});
  });

  it('parses valid config with ladder and skip', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      ladder: ['claude', 'codex'],
      skip: ['pool'],
      verifyCmd: 'echo verify',
      stateDir: '/custom/state',
      plansDir: '/custom/plans',
      retainMs: 12345,
      reportPollMs: 200,
      rc: '/custom/.common',
      loginShell: false
    }));
    const config = loadFileConfig(configPath);
    expect(config.ladder).toEqual(['claude', 'codex']);
    expect(config.skip).toEqual(['pool']);
    expect(config.verifyCmd).toBe('echo verify');
    expect(config.stateDir).toBe('/custom/state');
    expect(config.plansDir).toBe('/custom/plans');
    expect(config.retainMs).toBe(12345);
    expect(config.reportPollMs).toBe(200);
    expect(config.rc).toBe('/custom/.common');
    expect(config.loginShell).toBe(false);
  });

  it('ignores wrong-typed keys instead of throwing', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      ladder: 'not-an-array',
      skip: [1, 2, 3], 
      retainMs: 'not-a-number'
    }));
    const config = loadFileConfig(configPath);
    expect(config.ladder).toBeUndefined();
    expect(config.skip).toBeUndefined();
    expect(config.retainMs).toBeUndefined();
  });

  it('accepts null values for optional keys', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      ladder: null,
      skip: null
    }));
    const config = loadFileConfig(configPath);
    expect(config.ladder).toBeUndefined();
    expect(config.skip).toBeUndefined();
  });

  it('ignores array entries that are not strings in ladder', () => {
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      ladder: ['claude', 123, 'codex', null, 'pool']
    }));
    const config = loadFileConfig(configPath);
    expect(config.ladder).toEqual(['claude', 'codex', 'pool']);
  });
});