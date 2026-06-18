import { describe, it, expect, afterAll } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

// Throwaway state store, set BEFORE importing server/state (resolution is lazy). The chain writes
// its ladder audit trail under <STATE_DIR>/ladder; we read it back to assert turn-by-turn behavior.
const STATE_DIR = join(tmpdir(), `wladder-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;

import { runLadderChain, type LadderDrivers } from '../src/chain.ts';
import { LADDER, type Backend } from '../src/backends.ts';
import { getLadderHistory } from '../src/state.ts';
import type { RunResult } from '../src/runner.ts';

let sidSeq = 0;
const nextSid = () => `chain-test-${process.pid}-${sidSeq++}`;
const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function res(status: string, handle = 'h'): RunResult {
  return { status, exit_code: 0, backend: 'cmd' as Backend, handle, resume_token: handle, repo: '/x', log: '' };
}

// A driver that scripts each runRung outcome by call order. A stall now re-runs the SAME backend
// fresh (no resume) — both the retry and the climb go through runRung, scripted in call order.
function scriptedDrivers(opts: {
  rungs: string[];                 // status returned by each successive runRung call, in order
}): LadderDrivers & { runCalls: Backend[] } {
  const runCalls: Backend[] = [];
  let idx = 0;
  return {
    runCalls,
    runRung: async (backend: Backend) => { runCalls.push(backend); return res(opts.rungs[idx++] ?? 'failed', `run-${backend}`); },
  };
}

// Each test uses a fresh sid, so ladder histories never collide — no shared-state cleanup needed
// (and deleting the cached ladder/ dir would break sibling suites sharing the lazy WORKER_STATE_DIR).
describe('runLadderChain (auto-climb controller)', () => {
  it('stops on a first-rung done — no climb, single audit turn', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: [] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('done', 'first')), d, deadline);
    expect(final.status).toBe('done');
    expect(final.handle).toBe('first');
    expect(d.runCalls).toEqual([]);       // never climbed
    expect(getLadderHistory(sid).length).toBe(1);
  });

  it('climbs to the next backend on a hard failure (no retry on failed)', async () => {
    const sid = nextSid();
    // rung 0 = failed; first runRung (rung 1 = LADDER[1]) succeeds.
    const d = scriptedDrivers({ rungs: ['done'] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('failed')), d, deadline);
    expect(final.status).toBe('done');
    expect(d.runCalls).toEqual([LADDER[1]]);       // climbed exactly once, to rung 1 (no same-backend retry)
    expect(getLadderHistory(sid).map(h => h.result)).toEqual(['failed', 'done']);
  });

  it('on timeout: terminal — no retry, no climb (deadline+grace kill is final)', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: ['done'] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('timeout', 'rung0')), d, deadline);
    expect(final.status).toBe('timeout');
    expect(d.runCalls).toEqual([]);                // never climbed
    expect(getLadderHistory(sid).map(h => h.result)).toEqual(['timeout']);
  });

  it('on stalled: fresh re-runs the SAME backend once, succeeds → no climb', async () => {
    const sid = nextSid();
    // rung 0 stalls; the fresh retry of the SAME backend (LADDER[0]) succeeds.
    const d = scriptedDrivers({ rungs: ['done'] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('stalled', 'rung0')), d, deadline);
    expect(final.status).toBe('done');
    expect(d.runCalls).toEqual([LADDER[0]]);       // retried the SAME backend, not a climb
    expect(getLadderHistory(sid).map(h => h.result)).toEqual(['stalled', 'done']);
  });

  it('on stalled: re-runs same backend once, then climbs when the retry also stalls', async () => {
    const sid = nextSid();
    // rung 0 stalls → fresh retry of LADDER[0] stalls again → climb to LADDER[1] (done).
    const d = scriptedDrivers({ rungs: ['stalled', 'done'] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('stalled', 'rung0')), d, deadline);
    expect(final.status).toBe('done');
    expect(d.runCalls).toEqual([LADDER[0], LADDER[1]]); // retry same backend, then climb to next
    expect(getLadderHistory(sid).map(h => h.result)).toEqual(['stalled', 'stalled', 'done']);
  });

  it('returns "exhausted" when every backend fails, climbing through the whole ladder once', async () => {
    const sid = nextSid();
    // rung 0 fails (passed in) + every runRung fails → climbs LADDER.length-1 times then exhausts.
    const d = scriptedDrivers({ rungs: Array(LADDER.length).fill('failed') });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('failed')), d, deadline);
    expect(final.status).toBe('exhausted');
    expect(d.runCalls).toEqual(LADDER.slice(1));   // climbed through rungs 1..N-1, no further
    expect(getLadderHistory(sid).length).toBe(LADDER.length);
  });

  it('exhausting on a last-rung stall reports the retry attempt, not the stale pre-retry result', async () => {
    const sid = nextSid();
    // Every climbable rung fails until the LAST rung, which stalls → fresh retry of the last
    // backend also stalls → ladder exhausted. The exhausted result must carry the retry attempt.
    const rungs = [...Array(LADDER.length - 2).fill('failed'), 'stalled', 'stalled'];
    const d = scriptedDrivers({ rungs });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('failed')), d, deadline);
    expect(final.status).toBe('exhausted');
    expect(final.handle).toBe(`run-${LADDER[LADDER.length - 1]}`); // carried the retry result forward
  });

  it('stops without climbing when a rung is killed (operator intent honored)', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: ['done'] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('killed', 'rung0')), d, deadline);
    expect(final.status).toBe('killed');
    expect(d.runCalls).toEqual([]);                // killed → chain stops, no climb
  });

  it('climbs despite a missing ladder/ dir (ensureLadderDir resilience)', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: ['done'] });
    const deadline = Date.now() + 600_000;
    rmSync(join(STATE_DIR, 'ladder'), { recursive: true, force: true });
    const final = await runLadderChain(sid, Promise.resolve(res('failed')), d, deadline);
    expect(final.status).toBe('done');
    expect(d.runCalls).toEqual([LADDER[1]]);
  });

  it('KNOWN GAP: no total wall-clock cap — retries + climbs every rung, each with the FULL per-rung timeout', async () => {
    // The caller's `timeout` is applied PER RUNG, not across the chain: handleLadder computes
    // timeoutMs once and hands the SAME value to every launch (chain.ts). runLadderChain has no
    // notion of a cumulative deadline — given a stall it re-runs the same backend and then climbs
    // through EVERY remaining backend, each receiving a fresh full timeout. So worst-case cumulative
    // runtime ≈ (#retries + #climbs) × timeout, far exceeding the caller's `timeout`. NO source fix
    // in this scope — when the chain grows a total budget that short-circuits early, this changes.
    const sid = nextSid();
    // rung 0 stalls → fresh retry (also stalls) → climb; every climbed rung fails → exhausts the ladder.
    const d = scriptedDrivers({ rungs: ['stalled', ...Array(LADDER.length - 1).fill('failed')] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('stalled', 'rung0')), d, deadline);
    expect(final.status).toBe('exhausted');
    // retry of rung 0 (LADDER[0]) once, then climbed through every remaining backend.
    expect(d.runCalls).toEqual([LADDER[0], ...LADDER.slice(1)]);
    // Total full-timeout-bearing runRung calls = 1 retry + (LADDER.length-1) climbs = LADDER.length.
    expect(d.runCalls.length).toBe(LADDER.length);
  });
});
