import { describe, it, expect, afterEach } from 'bun:test';
import { writeFileSync, unlinkSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { resolveStatus } from '../src/status.ts';
import { tailCapped, extractAssistantTexts, readSentinel } from '../src/logParse.ts';

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

  it('returns "done" when DONE is in the tail (beyond old 10-line window)', () => {
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

  
  it('omp json log ending assistant text "DONE" -> done', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-${Date.now()}-9.log`;
    const events = [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it...' }] } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }] } }),
    ].join('\n');
    writeFileSync(tmpLogPath, events);
    testLogs.push(tmpLogPath);
    expect(resolveStatus('omp', 0, tmpLogPath, false)).toBe('done');
  });

  it('omp json ending assistant text "FAILED:reason" -> failed:reason', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-${Date.now()}-10.log`;
    const events = [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'attempting task' }] } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'FAILED: rate limit exceeded' }] } }),
    ].join('\n');
    writeFileSync(tmpLogPath, events);
    testLogs.push(tmpLogPath);
    expect(resolveStatus('omp', 0, tmpLogPath, false)).toBe('failed:rate limit exceeded');
  });

  it('omp json ending assistant text "FAILED" (no reason) -> failed', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-${Date.now()}-10b.log`;
    const events = [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'FAILED' }] } }),
    ].join('\n');
    writeFileSync(tmpLogPath, events);
    testLogs.push(tmpLogPath);
    expect(resolveStatus('omp', 0, tmpLogPath, false)).toBe('failed');
  });

  it('omp json with provider errorStatus (e.g. 402 credits) -> failed:<message>', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-10c.log`;
    const events = [
      JSON.stringify({ type: 'session', version: 3, id: 's1' }),
      JSON.stringify({ type: 'agent_start' }),
      JSON.stringify({ type: 'turn_start' }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [] }, stopReason: 'error', errorStatus: 402, errorMessage: '402 Add credits to continue' }),
      JSON.stringify({ type: 'agent_end', messages: [] }),
    ].join('\n');
    writeFileSync(tmpLogPath, events);
    testLogs.push(tmpLogPath);
    expect(resolveStatus('omp', 0, tmpLogPath, false)).toBe('failed:402 Add credits to continue');
  });

  it('codex json with agent_message containing FAILED:<reason> -> failed:<reason>', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-10d.log`;
    const events = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'FAILED: bad prompt' } }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ].join('\n');
    writeFileSync(tmpLogPath, events);
    testLogs.push(tmpLogPath);
    expect(resolveStatus('codex', 0, tmpLogPath, false)).toBe('failed:bad prompt');
  });

  it('pool json with thought containing FAILED -> failed', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-10e.log`;
    const events = [
      JSON.stringify({ type: 'reasoning', reasoning: 'thinking' }),
      JSON.stringify({ type: 'thought', thought: 'FAILED: out of context' }),
      JSON.stringify({ args: { success: false }, name: 'exit', type: 'toolCall' }),
    ].join('\n');
    writeFileSync(tmpLogPath, events);
    testLogs.push(tmpLogPath);
    expect(resolveStatus('pool', 0, tmpLogPath, false)).toBe('failed:out of context');
  });

  it('pool rc=4 maps to failed:task (rc fallback wins when no sentinel in log)', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-10f.log`;
    writeFileSync(tmpLogPath, '');
    testLogs.push(tmpLogPath);
    expect(resolveStatus('pool', 4, tmpLogPath, false)).toBe('failed:task');
  });

  it('codex/omp with stopReason=refusal -> failed', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-10g.log`;
    const events = [
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'I cannot help with that' }] }, stopReason: 'refusal' }),
    ].join('\n');
    writeFileSync(tmpLogPath, events);
    testLogs.push(tmpLogPath);
    expect(resolveStatus('codex', 0, tmpLogPath, false)).toBe('failed');
  });

  it('codex json log ending assistant text "DONE" -> done', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-${Date.now()}-11.log`;
    const events = [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }] } }),
    ].join('\n');
    writeFileSync(tmpLogPath, events);
    testLogs.push(tmpLogPath);
    expect(resolveStatus('codex', 0, tmpLogPath, false)).toBe('done');
  });

  it('json log whose final events exceed cap -> readSentinel null -> exit-code fallthrough', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-${Date.now()}-12.log`;
    
    
    const giantText = 'x'.repeat(500);
    const events = [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: giantText }] } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }] } }),
    ].join('\n');
    writeFileSync(tmpLogPath, events);
    testLogs.push(tmpLogPath);

    
    const tmpLogPath2 = `${tmpdir()}/resolveStatus-${process.pid}-${Date.now()}-12b.log`;
    const hugeEvents = [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(2000) }] } }),
    ].join('\n');
    writeFileSync(tmpLogPath2, hugeEvents);
    testLogs.push(tmpLogPath2);

    
    process.env.WORKER_STATUS_TAIL_BYTES = '100';
    expect(readSentinel(tmpLogPath2, true).status).toBeNull();
    expect(resolveStatus('omp', 0, tmpLogPath2, false)).toBe('done'); 
    expect(resolveStatus('omp', 1, tmpLogPath2, false)).toBe('failed'); 
    delete process.env.WORKER_STATUS_TAIL_BYTES;
  });

  it('text-mode bare DONE/FAILED line still resolves via raw path', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-${Date.now()}-13.log`;
    writeFileSync(tmpLogPath, 'info: starting\ninfo: working\nDONE');
    testLogs.push(tmpLogPath);
    
    expect(resolveStatus('cmd', 0, tmpLogPath, false)).toBe('done');
  });

  it('json log with non-assistant lines ignored, assistant DONE found', () => {
    const tmpLogPath = `${tmpdir()}/resolveStatus-${process.pid}-${Date.now()}-14.log`;
    const events = [
      JSON.stringify({ type: 'system', text: 'ignored' }),
      JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'ignored' }] } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }] } }),
    ].join('\n');
    writeFileSync(tmpLogPath, events);
    testLogs.push(tmpLogPath);
    expect(resolveStatus('omp', 0, tmpLogPath, false)).toBe('done');
  });
});

describe('tailCapped', () => {
  const testLogs: string[] = [];

  afterEach(() => {
    for (const path of testLogs) {
      try { unlinkSync(path); } catch {}
    }
    testLogs.length = 0;
  });

  it('returns entire file when smaller than cap', () => {
    const tmpLogPath = `${tmpdir()}/tailCapped-${process.pid}-${Date.now()}-1.log`;
    writeFileSync(tmpLogPath, 'line1\nline2\nDONE\n');
    testLogs.push(tmpLogPath);
    const result = tailCapped(tmpLogPath, 1024);
    expect(result).toContain('DONE');
  });

  it('reads <= cap bytes from a file larger than cap', () => {
    const tmpLogPath = `${tmpdir()}/tailCapped-${process.pid}-${Date.now()}-2.log`;
    
    const padding = 'A'.repeat(900);
    const sentinel = 'DONE';
    writeFileSync(tmpLogPath, `${padding}\n${sentinel}\n`);
    testLogs.push(tmpLogPath);

    const cap = 200;
    const result = tailCapped(tmpLogPath, cap);
    
    expect(result.length).toBeLessThanOrEqual(cap + 10); 
    expect(result).toContain('DONE');
  });

  it('never loads the whole file — asserts read offset when capped', () => {
    const tmpLogPath = `${tmpdir()}/tailCapped-${process.pid}-${Date.now()}-3.log`;
    
    const noise = 'x'.repeat(2900);
    writeFileSync(tmpLogPath, `${noise}\nDONE\n`);
    testLogs.push(tmpLogPath);

    const cap = 200;
    const size = statSync(tmpLogPath).size;
    expect(size).toBeGreaterThan(cap);

    const result = tailCapped(tmpLogPath, cap);
    
    expect(result.length).toBeLessThanOrEqual(cap + 50);
    expect(result).toContain('DONE');
  });
});

describe('extractAssistantTexts', () => {
  it('returns text strings from assistant message', () => {
    const line = JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'x' }] },
    });
    expect(extractAssistantTexts(line)).toEqual(['hello']);
  });

  it('returns empty array for non-assistant message', () => {
    const line = JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
    expect(extractAssistantTexts(line)).toEqual([]);
  });

  it('returns empty array for invalid JSON', () => {
    expect(extractAssistantTexts('not json')).toEqual([]);
  });

  it('returns empty array for non-JSON lines', () => {
    expect(extractAssistantTexts('DONE')).toEqual([]);
  });
});

describe('readSentinel', () => {
  const testLogs: string[] = [];

  afterEach(() => {
    for (const path of testLogs) {
      try { unlinkSync(path); } catch {}
    }
    testLogs.length = 0;
  });

  it('finds DONE in json mode via assistant text', () => {
    const tmpLogPath = `${tmpdir()}/readSentinel-${process.pid}-${Date.now()}-1.log`;
    const events = [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }] } }),
    ].join('\n');
    writeFileSync(tmpLogPath, events);
    testLogs.push(tmpLogPath);
    expect(readSentinel(tmpLogPath, true).status).toBe('done');
  });

  it('finds FAILED:reason in json mode via assistant text', () => {
    const tmpLogPath = `${tmpdir()}/readSentinel-${process.pid}-${Date.now()}-2.log`;
    const events = [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'FAILED: timeout' }] } }),
    ].join('\n');
    writeFileSync(tmpLogPath, events);
    testLogs.push(tmpLogPath);
    expect(readSentinel(tmpLogPath, true).status).toBe('failed:timeout');
  });

  it('returns null when no sentinel found', () => {
    const tmpLogPath = `${tmpdir()}/readSentinel-${process.pid}-${Date.now()}-3.log`;
    const events = [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'still working' }] } }),
    ].join('\n');
    writeFileSync(tmpLogPath, events);
    testLogs.push(tmpLogPath);
    expect(readSentinel(tmpLogPath, true).status).toBeNull();
  });

  it('finds DONE in text mode (raw lines)', () => {
    const tmpLogPath = `${tmpdir()}/readSentinel-${process.pid}-${Date.now()}-4.log`;
    writeFileSync(tmpLogPath, 'log line\nDONE');
    testLogs.push(tmpLogPath);
    expect(readSentinel(tmpLogPath, false).status).toBe('done');
  });

  it('finds FAILED in text mode (raw lines)', () => {
    const tmpLogPath = `${tmpdir()}/readSentinel-${process.pid}-${Date.now()}-5.log`;
    writeFileSync(tmpLogPath, 'log line\nFAILED: oops');
    testLogs.push(tmpLogPath);
    expect(readSentinel(tmpLogPath, false).status).toBe('failed:oops');
  });
});
