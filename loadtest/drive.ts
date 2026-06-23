import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const STATE = mkdtempSync(join(tmpdir(), 'load-state-'));
const REPO = mkdtempSync(join(tmpdir(), 'load-repo-'));

// workerEnv() hard-prepends ${HOME}/.bun/bin to the worker PATH, so a real ~/.bun/bin/omp would
// shadow the loadtest stub and silently drive real agents (burning API). Run under a fake HOME whose
// .bun/bin/omp IS the stub. HOME is captured at env.ts load time -> set before the dynamic import.
const FAKEHOME = mkdtempSync(join(tmpdir(), 'load-home-'));
mkdirSync(join(FAKEHOME, '.bun', 'bin'), { recursive: true });
chmodSync(join(process.cwd(), 'loadtest', 'stub-omp.sh'), 0o755);
symlinkSync(join(process.cwd(), 'loadtest', 'stub-omp.sh'), join(FAKEHOME, '.bun', 'bin', 'omp'));

process.env.HOME = FAKEHOME;
process.env.WORKER_STATE_DIR = STATE;
process.env.WORKER_LOGIN_SHELL = '0';
process.env.SKIP_codex = '1';
process.env.SKIP_pool = '1';
process.env.SKIP_cmd = '1';
process.env.SKIP_opencode = '1';
process.env.SKIP_claude = '1';
process.env.WORKER_POLL_MS = String(parseInt(process.env.LOAD_POLL_MS ?? '500', 10));
process.env.WORKER_RESUME_POLL_MS = String(parseInt(process.env.LOAD_RESUME_POLL_MS ?? '500', 10));

spawnSync('git', ['init', '-q'], { cwd: REPO });
spawnSync('git', ['-C', REPO, 'config', 'user.email', 'load@test']);
spawnSync('git', ['-C', REPO, 'config', 'user.name', 'load']);
writeFileSync(join(REPO, 'README.md'), '# load test\n');
spawnSync('git', ['-C', REPO, 'add', 'README.md']);
spawnSync('git', ['-C', REPO, 'commit', '-q', '-m', 'init']);

const N = parseInt(process.env.LOAD_N ?? '10', 10);

console.log(`load: N=${N} poll=${process.env.WORKER_POLL_MS}ms resume_poll=${process.env.WORKER_RESUME_POLL_MS}ms`);

const { launch, resetShutdownState } = await import('../src/lifecycle.ts');
const { __resetPidCache } = await import('../src/process.ts');
const { __resetActivityMonitors } = await import('../src/monitor.ts');
const { __resetSentinelCache } = await import('../src/logParse.ts');

__resetPidCache();
__resetActivityMonitors();
__resetSentinelCache();
resetShutdownState();

const t0 = Date.now();
const handles: { handle: string; promise: Promise<any> }[] = [];
for (let i = 0; i < N; i++) {
  const { handle, promise } = launch('omp', `task ${i}`, REPO, { sid: `load-${i}`, extraArgs: [], timeoutMs: 60_000 });
  handles.push({ handle, promise });
}

const rssSamples: number[] = [];
const sampler = setInterval(() => {
  try {
    const r = spawnSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
    const lines = r.stdout.split('\n').filter(Boolean);
    const myPid = process.pid;
    let totalRss = 0;
    for (const l of lines) {
      const parts = l.trim().split(/\s+/);
      if (parts[1] === String(myPid)) totalRss += Number(parts[2]);
    }
    rssSamples.push(totalRss);
  } catch {}
}, 250);

const results = await Promise.allSettled(handles.map(h => h.promise));
clearInterval(sampler);
const elapsed = Date.now() - t0;

const statuses = results.map((r, i) => r.status === 'fulfilled' ? `${handles[i].handle.slice(0, 12)}=${r.value.status}` : `${handles[i].handle.slice(0, 12)}=ERROR`);
const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && r.value.status !== 'done'));
console.log(`\nelapsed: ${elapsed}ms`);
console.log(`statuses: ${statuses.join(' ')}`);
console.log(`failed: ${failed.length}/${N}`);
for (const [i, r] of results.entries()) {
  if (r.status === 'rejected') console.log(`REJECT ${handles[i].handle.slice(0, 12)}: ${r.reason?.message ?? r.reason}`);
}

if (rssSamples.length > 0) {
  const avgRss = rssSamples.reduce((a, b) => a + b, 0) / rssSamples.length;
  const maxRss = Math.max(...rssSamples);
  console.log(`\nserver process RSS: avg=${(avgRss/1024).toFixed(1)} MiB, max=${(maxRss/1024).toFixed(1)} MiB (n=${rssSamples.length} samples, every 250ms)`);
}

const cpu = process.cpuUsage();
console.log(`\nCPU time (self): ${(cpu.user / 1000).toFixed(0)}ms user, ${(cpu.system / 1000).toFixed(0)}ms system`);
console.log(`wall: ${elapsed}ms, CPU%=${((cpu.user + cpu.system) / 1000 / elapsed * 100).toFixed(1)}%`);

const fs = await import('fs');
const handles2 = handles.map(h => h.handle);
for (const h of handles2) {
  try {
    const r = spawnSync('find', [STATE, '-name', 'run.log', '-path', `*${h}*`], { encoding: 'utf8' });
    for (const line of r.stdout.trim().split('\n').filter(Boolean)) {
      const tail = fs.readFileSync(line, 'utf8').split('\n').slice(-8).join('\n');
      console.log(`\n--- log tail for ${h.slice(0, 12)} (${line}) ---`);
      console.log(tail || '(empty)');
    }
  } catch {}
}

try { rmSync(STATE, { recursive: true, force: true }); } catch {}
try { rmSync(REPO, { recursive: true, force: true }); } catch {}