// Live, deterministic probe of the ladder WORKTREE-REUSE path (no API burn — stub backend).
// Drives the REAL launch() + runLadderChain() exactly as handleLadder does, with LADDER=['omp']
// pinned to a stub that stalls on rung 1 and only succeeds on rung 2 IF it finds rung 1's marker
// in the same worktree. Final `done` therefore proves: one worktree reused across rungs, work
// carried, continuation preamble threaded.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readdirSync, existsSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const STATE = mkdtempSync(join(tmpdir(), 'reuse-state-'));
const REPO = mkdtempSync(join(tmpdir(), 'reuse-repo-'));
// workerEnv() hard-prepends ${HOME}/.bun/bin to the worker PATH, so the ONLY way a stub wins over a
// real ~/.bun/bin/omp is a fake HOME whose .bun/bin/omp IS the stub. HOME is captured at env.ts load
// time, so it must be set before the dynamic import below.
const FAKEHOME = mkdtempSync(join(tmpdir(), 'reuse-home-'));
mkdirSync(join(FAKEHOME, '.bun', 'bin'), { recursive: true });
chmodSync(join(process.cwd(), 'loadtest', 'stub-omp-stall.sh'), 0o755);
symlinkSync(join(process.cwd(), 'loadtest', 'stub-omp-stall.sh'), join(FAKEHOME, '.bun', 'bin', 'omp'));

process.env.HOME = FAKEHOME;
process.env.WORKER_STATE_DIR = STATE;
process.env.WORKER_LOGIN_SHELL = '0';
process.env.WORKER_SKIP_AUTH_GATE = '1';
for (const b of ['codex', 'cmd', 'pool', 'opencode', 'claude']) process.env[`SKIP_${b}`] = '1';
process.env.WORKER_STALL_MS = '2500';     // rung 1 goes silent past this -> stalled fast
process.env.WORKER_POLL_MS = '300';
process.env.WORKER_GRACE_MS = '60000';

spawnSync('git', ['init', '-q'], { cwd: REPO });
spawnSync('git', ['-C', REPO, 'config', 'user.email', 'reuse@test']);
spawnSync('git', ['-C', REPO, 'config', 'user.name', 'reuse']);
writeFileSync(join(REPO, 'README.md'), '# reuse probe\n');
spawnSync('git', ['-C', REPO, 'add', 'README.md']);
spawnSync('git', ['-C', REPO, 'commit', '-q', '-m', 'init']);

const { launch, resetShutdownState } = await import('../src/lifecycle.ts');
const { runLadderChain } = await import('../src/chain.ts');
const { LADDER } = await import('../src/backends.ts');
const state = await import('../src/state.ts');
const { __resetPidCache } = await import('../src/process.ts');
const { __resetActivityMonitors } = await import('../src/runner.ts');
const { __resetSentinelCache } = await import('../src/logParse.ts');

__resetPidCache(); __resetActivityMonitors(); __resetSentinelCache(); resetShutdownState();

console.log(`LADDER = ${JSON.stringify(LADDER)} (expect ["omp"])`);

const sid = 'reuse-1';
const deadlineAt = Date.now() + 120_000;
state.createChainLock(sid, process.pid);
state.saveChainMeta(sid, { deadlineAt });

const prompt = 'do the reuse task';
const first = launch('omp', prompt, REPO, { sid, deadlineAt, completionLock: state.chainLockPath(sid) });

// faithful copy of handleLadder's drivers: every later rung reuses the FIRST rung's worktree + base_sha
const drivers = {
  runRung: (backend: any, seed: any) => {
    const firstJob = state.getJob(first.handle);
    return launch(backend, prompt, REPO, {
      sid, deadlineAt, completionLock: state.chainLockPath(sid),
      reuseWorktree: firstJob?.worktree_path, reuseBaseSha: firstJob?.base_sha, seed,
    }).promise;
  },
};

const t0 = Date.now();
const result = await runLadderChain(sid, first.promise, drivers, deadlineAt);
state.removeChainLock(sid);
const elapsed = Date.now() - t0;

// ---- assertions ----
let fail = 0;
const ok = (cond: boolean, label: string, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!cond) fail++;
};

console.log(`\nchain status: ${result.status}  (elapsed ${elapsed}ms)`);
console.log(`ladder history: ${JSON.stringify(state.getLadderHistory(sid))}`);

// 1. chain finished `done` — only reachable if rung 2 saw rung 1's marker in a shared worktree
ok(result.status === 'done', 'chain status == done (retry rung succeeded via carried work)', result.status);

// 2. exactly ONE worktree across the whole chain: count `tree` dirs created under STATE
const trees: string[] = [];
const root = readdirSync(STATE, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== 'ladder' && d.name !== 'tmux');
for (const proj of root) {
  const projPath = join(STATE, proj.name);
  for (const h of readdirSync(projPath, { withFileTypes: true }).filter(d => d.isDirectory())) {
    if (existsSync(join(projPath, h.name, 'tree'))) trees.push(join(proj.name, h.name, 'tree'));
  }
}
ok(trees.length === 1, 'exactly ONE worktree created across all rungs', `found ${trees.length}: ${trees.join(', ')}`);

// 3. the reused worktree carries rung 1's marker AND rung 2's result, and committed them
const wt = trees.length ? join(STATE, trees[0]) : '';
ok(!!wt && existsSync(join(wt, '.attempt')), 'rung 1 marker present in reused worktree');
ok(!!wt && existsSync(join(wt, 'result.txt')), 'rung 2 result present in same worktree');
const logb = wt ? spawnSync('git', ['-C', wt, 'log', '--oneline'], { encoding: 'utf8' }).stdout.trim() : '';
ok(/result\.txt|carried|commit/i.test(logb) || logb.split('\n').length >= 2, 'worker committed the carried work on green', logb.replace(/\n/g, ' | '));

// 4. continuation preamble reached rung 2 (seed threaded through reuse)
const specSeen = wt && existsSync(join(wt, '.spec-rung2')) ? readFileSync(join(wt, '.spec-rung2'), 'utf8') : '';
ok(/Continuation\./.test(specSeen) && /already applied in this worktree/i.test(specSeen),
   'rung 2 spec carried the continuation preamble', specSeen.slice(0, 80).replace(/\n/g, ' '));

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}`);

if (process.env.KEEP === '1') {
  console.log(`\n[KEEP] STATE=${STATE}`);
  for (const t of trees) {
    const tp = join(STATE, t);
    console.log(`[KEEP] worktree ${tp} contents:`, readdirSync(tp));
  }
  // dump each handle's run.log tail
  for (const proj of root) {
    const projPath = join(STATE, proj.name);
    for (const h of readdirSync(projPath, { withFileTypes: true }).filter(d => d.isDirectory())) {
      const lp = join(projPath, h.name, 'run.log');
      if (existsSync(lp)) console.log(`\n[KEEP] run.log ${h.name}:\n${readFileSync(lp, 'utf8').slice(-600) || '(empty)'}`);
    }
  }
}
try { if (process.env.KEEP !== '1') rmSync(STATE, { recursive: true, force: true }); } catch {}
try { rmSync(REPO, { recursive: true, force: true }); } catch {}
try { rmSync(FAKEHOME, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
