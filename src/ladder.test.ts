import { describe, it, expect, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { ladderNext } from './ladder.ts';
import { LADDER, type Backend } from './backends.ts';
import { appendLadder, ladderPath } from './state.ts';

describe('ladderNext', () => {
  const testSids: string[] = [];

  afterEach(() => {
    for (const sid of testSids) {
      try { unlinkSync(ladderPath(sid)); } catch {}
    }
    testSids.length = 0;
  });

  it('returns first rung when no history (climb=false)', () => {
    const sid = `ladder-test-${process.pid}-${Date.now()}-1`;
    testSids.push(sid);
    const result = ladderNext(sid, false);
    expect(result).not.toBeNull();
    expect(result!.backend).toBe(LADDER[0]);
    expect(result!.turn).toBe(1);
  });

  it('advances to next rung when climb=true after seeding first rung', () => {
    const sid = `ladder-test-${process.pid}-${Date.now()}-2`;
    testSids.push(sid);
    // Seed first rung (turn 1) with LADDER[0]
    appendLadder(sid, 1, LADDER[0], 'failed');
    
    const result = ladderNext(sid, true);
    expect(result).not.toBeNull();
    expect(result!.backend).toBe(LADDER[1]);
    expect(result!.turn).toBe(2);
  });

  it('returns null when ladder exhausted (all rungs seeded, climb=true)', () => {
    const sid = `ladder-test-${process.pid}-${Date.now()}-3`;
    testSids.push(sid);
    
    // Seed ALL rungs
    for (let i = 0; i < LADDER.length; i++) {
      appendLadder(sid, i + 1, LADDER[i], 'failed');
    }
    
    // ladderNext should return null when all rungs have been tried
    const result = ladderNext(sid, true);
    expect(result).toBeNull();
  });
});