// Throwaway aggressive verification of the two bug fixes. Real spawns, stub backends (no API burn).
//   Part A — worktree-add race: K concurrent addWorktreeAsync on one repo must all succeed + be
//            distinct, and a real error (dup branch) must fail FAST (not spin the transient retry).
//   Part B — report semantics on a REAL ladder climb ['cmd','omp']: rung-1 cmd makes no changes
//            (gated failed:no-changes), rung-2 omp commits real work (done). This proves:
//              (1) the no-changes gate writes the RECONCILED status into ladder history (row-1 is
//                  'failed:no-changes', never 'done') — so GOAL.md's "prints completed for an empty
//                  branch" cannot occur: history is only 'done' when a rung truly committed.
//              (2) report line-1 for a SUCCESSFUL climb must be 'completed'. terminalStatus reads the
//                  chain HISTORY (last row 'done'), not the first rung's job — the first handle is the
//                  failed rung-1. A fix that cross-checks first.handle's job status breaks this.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const STATE = mkdtempSync(join(tmpdir(), 'vf-state-'));
const REPO = mkdtempSync(join(tmpdir(), 'vf-repo-'));      // ladder repo (Part B)
const REPO_A = mkdtempSync(join(tmpdir(), 'vf-race-'));    // race repo (Part A)
const FAKEHOME = mkdtempSync(join(tmpdir(), 'vf-home-'));
const BIN = join(FAKEHOME, '.bun', 'bin');
mkdirSync(BIN, { recursive: true });

// rung-1 cmd: plain backend, echo activity, write NOTHING -> resolveStatus done -> gated no-changes.
const STUB_CMD = join(BIN, 'cmd');
writeFileSync(STUB_CMD, '#!/usr/bin/env bash\nset -u\necho "cmd rung: made no changes"\nexit 0\n');
chmodSync(STUB_CMD, 0o755);
// rung-2 omp: JSON backend, write result.txt into the (reused) worktree, emit DONE sentinel, exit 0.
const STUB_OMP = join(BIN, 'omp');
writeFileSync(STUB_OMP,
  '#!/usr/bin/env bash\nset -u\necho "carried by omp" > result.txt\n' +
  'printf \'%s\\n\' \'{"message":{"role":"assistant","content":[{"type":"text","text":"DONE"}]}}\'\nexit 0\n');
chmodSync(STUB_OMP, 0o755);

process.env.HOME = FAKEHOME;
process.env.WORKER_STATE_DIR = STATE;
process.env.WORKER_LOGIN_SHELL = '0';
process.env.WORKER_SKIP_AUTH_GATE = '1';          // keep cmd in the ladder without a real auth check
for (const b of ['codex', 'pool', 'opencode', 'claude']) process.env[`SKIP_${b}`] = '1';
process.env.WORKER_STALL_MS = '8000';
process.env.WORKER_POLL_MS = '250';
process.env.WORKER_GRACE_MS = '60000';

function gitInit(dir: string) {
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'vf@test']);
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'vf']);
  writeFileSync(join(dir, 'README.md'), '# vf\n');
  spawnSync('git', ['-C', dir, 'add', 'README.md']);
  spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
}
gitInit(REPO);
gitInit(REPO_A);

const { launch, resetShutdownState } = await import('../src/lifecycle.ts');
const { runLadderChain } = await import('../src/chain.ts');
const { LADDER } = await import('../src/backends.ts');
const { addWorktreeAsync, listWorktrees } = await import('../src/worktree.ts');
const { terminalStatus, statusLine } = await import('../src/report.ts');
const state = await import('../src/state.ts');
const { __resetPidCache } = await import('../src/process.ts');
const { __resetActivityMonitors } = await import('../src/runner.ts');
const { __resetSentinelCache } = await import('../src/logParse.ts');
__resetPidCache(); __resetActivityMonitors(); __resetSentinelCache(); resetShutdownState();

let fail = 0;
const ok = (cond: boolean, label: string, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!cond) fail++;
};

// ============================ Part A — worktree-add race ============================
console.log('\n== Part A: concurrent worktree adds ==');
const K = 60;
const settled = await Promise.allSettled(
  Array.from({ length: K }, (_, i) => addWorktreeAsync(REPO_A, `race-${i}`)),
);
const rejects = settled.filter(s => s.status === 'rejected');
for (const r of rejects) console.log(`  REJECT: ${(r as PromiseRejectedResult).reason?.message ?? r}`);
const paths = settled.flatMap(s => s.status === 'fulfilled' ? [s.value as string] : []);
ok(rejects.length === 0, `${K} concurrent adds, 0 failures`, `${rejects.length} rejected`);
ok(new Set(paths).size === paths.length, 'all worktree paths distinct', `${new Set(paths).size}/${paths.length} unique`);
ok(paths.every(p => existsSync(p)), 'every returned worktree path exists on disk');
ok(listWorktrees(REPO_A).length === K + 1, `git sees ${K + 1} worktrees (main + ${K})`, `saw ${listWorktrees(REPO_A).length}`);

// real error must fail FAST, not spin the transient-retry budget (~6*backoff)
await addWorktreeAsync(REPO_A, 'dup');           // first ok -> branch worker/dup now exists
const tNeg = Date.now();
let negErr = '';
try { await addWorktreeAsync(REPO_A, 'dup'); } catch (e) { negErr = (e as Error).message; }
const negMs = Date.now() - tNeg;
ok(negErr !== '', 'duplicate-handle add rejects (real error surfaces)', negErr.slice(0, 80));
ok(negMs < 1500, 'duplicate-handle add fails FAST (no transient-retry spin)', `${negMs}ms`);
ok(!/Undefined error|commondir/i.test(negErr), 'failure is the real cause, not a swallowed transient');

// ============================ Part B — report on a real ladder climb ============================
console.log(`\n== Part B: ladder climb ${JSON.stringify(LADDER)} (expect ["cmd","omp"]) ==`);
ok(LADDER.length === 2 && LADDER[0] === 'cmd' && LADDER[1] === 'omp', 'ladder is [cmd, omp]', JSON.stringify(LADDER));

const sid = 'vf-climb';
const deadlineAt = Date.now() + 120_000;
state.createChainLock(sid, process.pid);
state.saveChainMeta(sid, { deadlineAt });
const prompt = 'do the climb task';
const first = launch(LADDER[0], prompt, REPO, { sid, deadlineAt, completionLock: state.chainLockPath(sid) });
const drivers = {
  runRung: (backend: any, seed: any) => {
    const fj = state.getJob(first.handle);
    return launch(backend, prompt, REPO, {
      sid, deadlineAt, completionLock: state.chainLockPath(sid),
      reuseWorktree: fj?.worktree_path, reuseBaseSha: fj?.base_sha, seed,
    }).promise;
  },
};
const result = await runLadderChain(sid, first.promise, drivers, deadlineAt);
state.removeChainLock(sid);

const hist = state.getLadderHistory(sid);
console.log(`chain status: ${result.status}`);
console.log(`ladder history: ${JSON.stringify(hist)}`);
console.log(`first(cmd) job status: ${state.getJob(first.handle)?.status}`);

ok(result.status === 'done', 'chain climbs to done (omp committed real work)', result.status);
ok(hist.length === 2, 'two ladder rows recorded', `${hist.length}`);
// (1) no-changes gate reconciles into HISTORY — row-1 is failed:no-changes, NOT done
ok(hist[0]?.result === 'failed:no-changes', 'rung-1 history row is failed:no-changes (gate reconciled, not "done")', hist[0]?.result);
ok(hist[1]?.result === 'done', 'rung-2 history row is done', hist[1]?.result);
ok(state.getJob(first.handle)?.status === 'failed:no-changes', 'first(cmd) job reconciled to failed:no-changes');
// (2) report line-1 for a SUCCESSFUL climb must be completed — this is what my report.ts fix breaks
const ts = terminalStatus(first.handle, state.chainLockPath(sid));
const line = statusLine(ts);
console.log(`terminalStatus(first.handle) = ${ts}  ->  statusLine = ${line}`);
ok(ts === 'done', 'terminalStatus reads chain history (done), not first rung job', ts);
ok(line === 'completed', 'report line-1 == completed for a successful climb', line);

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}`);
if (process.env.KEEP !== '1') {
  for (const d of [STATE, REPO, REPO_A, FAKEHOME]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}
process.exit(fail === 0 ? 0 : 1);
