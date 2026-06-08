import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';

// Throwaway state store, set BEFORE importing server/state (resolution is lazy). The chain writes
// its ladder audit trail under <STATE_DIR>/ladder; we read it back to assert turn-by-turn behavior.
const STATE_DIR = join(tmpdir(), `wladder-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;

import { runLadderChain, type LadderDrivers } from './server.ts';
import { LADDER, type Backend } from './backends.ts';
import { getLadderHistory } from './state.ts';
import type { RunResult } from './runner.ts';

let sidSeq = 0;
const nextSid = () => `chain-test-${process.pid}-${sidSeq++}`;

function res(status: string, handle = 'h'): RunResult {
  return { status, exit_code: 0, backend: 'cmd' as Backend, handle, resume_token: handle, repo: '/x', shortstat: '', log: '' };
}

// A driver that scripts each rung's outcome by call order. runRung pulls the next scripted result;
// resumeRung returns whatever `resume` yields. Both record their calls for assertion.
function scriptedDrivers(opts: {
  rungs: string[];                 // status returned by each successive runRung (rung 1, 2, ...)
  resume?: (handle: string) => string; // status returned by resumeRung (default: same failure → 'failed')
}): LadderDrivers & { runCalls: Backend[]; resumeCalls: string[] } {
  const runCalls: Backend[] = [];
  const resumeCalls: string[] = [];
  let idx = 0;
  return {
    runCalls, resumeCalls,
    runRung: async (backend: Backend) => { runCalls.push(backend); return res(opts.rungs[idx++] ?? 'failed', `run-${backend}`); },
    resumeRung: async (handle: string) => { resumeCalls.push(handle); return res(opts.resume ? opts.resume(handle) : 'failed', `resumed-${handle}`); },
  };
}

// Each test uses a fresh sid, so ladder histories never collide — no shared-state cleanup needed
// (and deleting the cached ladder/ dir would break sibling suites sharing the lazy WORKER_STATE_DIR).
describe('runLadderChain (auto-climb controller)', () => {
  it('stops on a first-rung done — no climb, single audit turn', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: [] });
    const final = await runLadderChain(sid, Promise.resolve(res('done', 'first')), d);
    expect(final.status).toBe('done');
    expect(final.handle).toBe('first');
    expect(d.runCalls).toEqual([]);       // never climbed
    expect(d.resumeCalls).toEqual([]);    // never resumed
    expect(getLadderHistory(sid).length).toBe(1);
  });

  it('climbs to the next backend on a hard failure (no resume on failed)', async () => {
    const sid = nextSid();
    // rung 0 = failed; first runRung (rung 1 = LADDER[1]) succeeds.
    const d = scriptedDrivers({ rungs: ['done'] });
    const final = await runLadderChain(sid, Promise.resolve(res('failed')), d);
    expect(final.status).toBe('done');
    expect(d.resumeCalls).toEqual([]);             // failed never resumes
    expect(d.runCalls).toEqual([LADDER[1]]);       // climbed exactly once, to rung 1
    expect(getLadderHistory(sid).map(h => h.result)).toEqual(['failed', 'done']);
  });

  it('on timeout: resumes the SAME backend once, and stops if the resume succeeds (no climb)', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: ['done'], resume: () => 'done' });
    const final = await runLadderChain(sid, Promise.resolve(res('timeout', 'rung0')), d);
    expect(final.status).toBe('done');
    expect(d.resumeCalls).toEqual(['rung0']);      // resumed the timed-out handle once
    expect(d.runCalls).toEqual([]);                // resume succeeded → never climbed
    expect(getLadderHistory(sid).map(h => h.result)).toEqual(['timeout', 'done']);
  });

  it('on stopped: resumes once, then climbs when the resume also fails', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: ['done'], resume: () => 'stopped' });
    const final = await runLadderChain(sid, Promise.resolve(res('stopped', 'rung0')), d);
    expect(final.status).toBe('done');
    expect(d.resumeCalls).toEqual(['rung0']);      // resumed exactly once
    expect(d.runCalls).toEqual([LADDER[1]]);       // resume failed → climbed to rung 1
    expect(getLadderHistory(sid).map(h => h.result)).toEqual(['stopped', 'stopped', 'done']);
  });

  it('returns "exhausted" when every backend fails, climbing through the whole ladder once', async () => {
    const sid = nextSid();
    // rung 0 fails (passed in) + every runRung fails → climbs LADDER.length-1 times then exhausts.
    const d = scriptedDrivers({ rungs: Array(LADDER.length).fill('failed') });
    const final = await runLadderChain(sid, Promise.resolve(res('failed')), d);
    expect(final.status).toBe('exhausted');
    expect(d.runCalls).toEqual(LADDER.slice(1));   // climbed through rungs 1..N-1, no further
    expect(getLadderHistory(sid).length).toBe(LADDER.length);
  });

  it('exhausting on a last-rung resume failure reports the resume attempt, not the stale pre-resume result', async () => {
    const sid = nextSid();
    // Every climbable rung fails, and the LAST rung returns stopped → resume → resume fails → exhausted.
    // The exhausted result must carry the post-resume attempt (handle `resumed-...`), not the stale stopped one.
    const rungs = [...Array(LADDER.length - 2).fill('failed'), 'stopped'];
    const d = scriptedDrivers({ rungs, resume: () => 'failed' });
    const final = await runLadderChain(sid, Promise.resolve(res('failed')), d);
    expect(final.status).toBe('exhausted');
    expect(d.resumeCalls).toEqual([`run-${LADDER[LADDER.length - 1]}`]); // resumed only the last rung
    expect(final.handle).toBe(`resumed-run-${LADDER[LADDER.length - 1]}`); // carried r2 forward (regression guard)
  });

  it('stops without climbing when a rung is killed (operator intent honored)', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: ['done'] });
    const final = await runLadderChain(sid, Promise.resolve(res('killed', 'rung0')), d);
    expect(final.status).toBe('killed');
    expect(d.runCalls).toEqual([]);                // killed → chain stops, no climb
    expect(d.resumeCalls).toEqual([]);
  });
});
