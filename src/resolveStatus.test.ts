import { describe, it, expect, afterEach } from 'bun:test';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { resolveStatus } from './runner.ts';

describe('resolveStatus', () => {
  const testLogs: string[] = [];

  afterEach(() => {
    for (const path of testLogs) {
      try { unlinkSync(path); } catch {}
    }
    testLogs.length = 0;
  });

  it('returns "done" when log last line is DONE', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-${Date.now()}-1.log`;
    writeFileSync(tmpLogPath, 'Some log line\nDONE');
    testLogs.push(tmpLogPath);
    const result = resolveStatus('cmd', 0, tmpLogPath, false);
    expect(result).toBe('done');
  });

  it('returns "done" when log contains DONE buried in last 10 lines', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-${Date.now()}-2.log`;
    const lines = [];
    for (let i = 0; i < 15; i++) {
      lines.push(`line ${i}`);
    }
    lines[12] = 'DONE';
    writeFileSync(tmpLogPath, lines.join('\n'));
    testLogs.push(tmpLogPath);
    const result = resolveStatus('cmd', 0, tmpLogPath, false);
    expect(result).toBe('done');
  });

  it('returns "failed:reason" when log contains FAILED: reason', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-${Date.now()}-3.log`;
    writeFileSync(tmpLogPath, 'Some log line\nFAILED: something went wrong');
    testLogs.push(tmpLogPath);
    const result = resolveStatus('cmd', 0, tmpLogPath, false);
    expect(result).toBe('failed:something went wrong');
  });

  it('returns "failed" when log contains FAILED without reason', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-${Date.now()}-4.log`;
    writeFileSync(tmpLogPath, 'Some log line\nFAILED');
    testLogs.push(tmpLogPath);
    const result = resolveStatus('cmd', 0, tmpLogPath, false);
    expect(result).toBe('failed');
  });

  it('returns "timeout" when timedOut is true', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-${Date.now()}-5.log`;
    writeFileSync(tmpLogPath, '');
    testLogs.push(tmpLogPath);
    const result = resolveStatus('cmd', 0, tmpLogPath, true);
    expect(result).toBe('timeout');
  });

  it('returns "failed:max-turns" for cmd backend with rc=8', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-${Date.now()}-6.log`;
    writeFileSync(tmpLogPath, '');
    testLogs.push(tmpLogPath);
    const result = resolveStatus('cmd', 8, tmpLogPath, false);
    expect(result).toBe('failed:max-turns');
  });

  it('returns "failed:task" for pool backend with rc=4', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-${Date.now()}-7.log`;
    writeFileSync(tmpLogPath, '');
    testLogs.push(tmpLogPath);
    const result = resolveStatus('pool', 4, tmpLogPath, false);
    expect(result).toBe('failed:task');
  });

  it('returns "done" for empty log with rc=0', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-${Date.now()}-8.log`;
    writeFileSync(tmpLogPath, '');
    testLogs.push(tmpLogPath);
    const result = resolveStatus('cmd', 0, tmpLogPath, false);
    expect(result).toBe('done');
  });
});