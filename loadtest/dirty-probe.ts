import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const STATE = mkdtempSync(join(tmpdir(), 'probe-state-'));
const REPO = mkdtempSync(join(tmpdir(), 'probe-repo-'));
process.env.WORKER_STATE_DIR = STATE;
process.env.WORKER_LOGIN_SHELL = '0';
process.env.SKIP_omp = '1';
process.env.SKIP_codex = '1';
process.env.SKIP_pool = '1';
process.env.SKIP_cmd = '1';
process.env.SKIP_opencode = '1';
process.env.SKIP_claude = '1';
process.env.PATH = `${process.env.HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin`;

spawnSync('git', ['init', '-q'], { cwd: REPO });
spawnSync('git', ['-C', REPO, 'config', 'user.email', 'p@t']);
spawnSync('git', ['-C', REPO, 'config', 'user.name', 'p']);
writeFileSync(join(REPO, 'README.md'), '# x\n');
spawnSync('git', ['-C', REPO, 'add', 'README.md']);
spawnSync('git', ['-C', REPO, 'commit', '-q', '-m', 'init']);

const { startActivityMonitor, __resetActivityMonitors } = await import('../src/monitor.ts');
const { runWorker } = await import('../src/runner.ts');
import * as stateMod from '../src/state.ts';
const insertJob = stateMod.insertJob;
const stateLogPath = stateMod.logPath;

__resetActivityMonitors();

const handle = 'probe-1';
const lp = stateLogPath(handle, REPO);
insertJob({ handle, backend: 'cmd', sid: 'p', repo: REPO, log_path: lp });

const mon = startActivityMonitor(REPO, lp);
writeFileSync(join(REPO, 'new.txt'), 'hello\n');
spawnSync('git', ['-C', REPO, 'add', 'new.txt']);
spawnSync('git', ['-C', REPO, 'commit', '-q', '-m', 'add new']);

await Bun.sleep(100);

console.log('mon.sig (before any settle):', JSON.stringify(mon.sig));

await Bun.sleep(2000);
console.log('mon.sig (after 2s idle):', JSON.stringify(mon.sig));

mon.dispose();

const r = await runWorker(['bash', '-c', 'echo; echo DONE; touch new2.txt'], REPO, handle, 'cmd', lp, '');
console.log('\nrunWorker result:');
console.log('  status:', r.status);

try { rmSync(STATE, { recursive: true, force: true }); } catch {}
try { rmSync(REPO, { recursive: true, force: true }); } catch {}