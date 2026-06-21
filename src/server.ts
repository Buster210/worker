import { basename } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import {
  getJob, updateJob, finalizeJob, getAllJobs, pruneOldJobs, readSpec, loadChainMeta, saveChainMeta,
  pruneTranscript, getLadderHistory,
} from './state.ts';
import { LADDER, ALL_BACKENDS, type Backend } from './backends.ts';
import { backendShellArgv } from './runner.ts';
import { workerEnv } from './env.ts';
import { resolveStatus } from './status.ts';
import { isProcessAlive } from './process.ts';
import { sweepStaleJobs, reapStoppedJobs, sweepChainLocks } from './maintenance.ts';
import { launch, forceKillJob, assertRepo, resumeLaunch as lifecycleResumeLaunch, shutdown, spawnReaper } from './lifecycle.ts';
import { handleLadder } from './chain.ts';
import { terminalStatus } from './report.ts';

// --- MCP tool handlers (keep in server.ts) ---

export function reply(r: unknown) {
  const text = typeof r === 'string' ? r : JSON.stringify(r);
  return { content: [{ type: 'text' as const, text }] };
}

export function handleRun(args: { backend: Backend; specFile: string; model?: string; dir: string; timeout?: number; extraArgs?: string[] }): { handle: string; status: string } {
  assertRepo(args.dir);
  const prompt = readSpec(args.specFile);
  const sid = randomUUID();
  const { handle, promise } = launch(args.backend, prompt, args.dir,
    { sid, model: args.model, extraArgs: args.extraArgs, timeoutMs: args.timeout ? args.timeout * 1000 : undefined });
  void promise.catch(() => {});
  return { handle, status: 'running' };
}

export function handleResume(args: { handle: string; specFile: string; dir: string; timeout?: number; extraArgs?: string[] }): { handle: string; status: string } {
  const prompt = readSpec(args.specFile);
  const { handle, promise } = lifecycleResumeLaunch({ handle: args.handle, prompt, dir: args.dir, timeout: args.timeout, extraArgs: args.extraArgs });
  void promise.catch(() => {});
  return { handle, status: 'running' };
}

export function handleKill(args: { handle: string }): string {
  const { handle } = args;
  const job = getJob(handle);
  if (!job) throw new Error(`No job found: ${handle}`);
  const TERMINAL = /^(done|failed|timeout|killed)/;
  if (TERMINAL.test(job.status)) {
    return `already ${job.status}`;
  }
  updateJob(handle, { kill_requested: true });
  const finalizeKilled = () => finalizeJob(handle, resolveStatus(job.backend, 0, job.log_path, false));
  if (job.backend === 'claude_tmux') {
    forceKillJob(job);
    return `killed: ${handle} (${finalizeKilled()})`;
  }
  if (job.status === 'stopped' && job.worker_pid) {
    forceKillJob(job);
    return `killed: ${handle} (${finalizeKilled()})`;
  }
  if (job.worker_pid) {
    try { process.kill(-job.worker_pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(-job.worker_pid, 'SIGKILL'); } catch {} }, 3_000).unref?.();
  }
  if (!isProcessAlive(job.worker_pid, job.started)) {
    return `killed: ${handle} (${finalizeKilled()})`;
  }
  return `killed: ${handle}`;
}

export function handleStatus(args: { handle: string }): Record<string, unknown> {
  const { handle } = args;
  const job = getJob(handle);
  if (!job) throw new Error(`No job found: ${handle}`);
  // A chain handle is just the FIRST rung — its own status goes stale once the chain climbs on.
  // Mirror worker-report: while the chain lock exists the chain is running; once it is gone, report the
  // chain's terminal status from ladder history so worker_status and worker-report agree.
  const cl = job.completion_lock ?? '';
  if (cl.endsWith('.chain.lock')) {
    const running = existsSync(cl);
    if (running) return { status: 'running', alive: true, started: job.started };
    const status = terminalStatus(handle, cl);
    const result: Record<string, unknown> = { status, alive: false, started: job.started };
    if (status === 'exhausted') {
      const sid = basename(cl).replace(/\.chain\.lock$/, '');
      result.rungs = getLadderHistory(sid);
    }
    return result;
  }
  let alive = false;
  if (job.worker_pid && (job.status === 'running' || job.status === 'stopped')) {
    alive = isProcessAlive(job.worker_pid, job.started);
  }
  return { status: job.status, alive, started: job.started };
}

export function handleDoctor(args: { backend?: string }): string {
  const backends = args.backend ? [args.backend] : ALL_BACKENDS.filter(be => be !== 'claude_tmux');
  const down = backends.filter(be => {
    const [cmd, ...probeArgs] = backendShellArgv([be, '--version']);
    const r = spawnSync(cmd, probeArgs, { stdio: 'ignore', env: workerEnv(), timeout: 10_000 });
    return r.status !== 0 || r.error != null;
  });
  return down.length === 0 ? 'All workers operational.' : `Not operational: ${down.join(', ')}`;
}

export function handleList(args: { status?: string; limit?: number }): Record<string, unknown>[] {
  const { status, limit = 20 } = args;
  return getAllJobs()
    .filter(j => !status || j.status === status)
    .sort((a, b) => (b.started ?? '').localeCompare(a.started ?? ''))
    .slice(0, limit)
    .map(j => ({ handle: j.handle, status: j.status, repo: j.repo, task: j.task, started: j.started }));
}

export function handleExtend(args: { handle: string; seconds: number }): { handle: string; deadline_at: number } {
  const { handle, seconds } = args;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) {
    throw new Error('seconds must be an integer between 1 and 86400');
  }
  const job = getJob(handle);
  if (!job) throw new Error(`No job found: ${handle}`);

  const now = Date.now();

  // A chain handle carries the chain completion_lock (`...ladder/<sid>.chain.lock`). For these the
  // extend is chain-WIDE: bump the .chain.meta deadline that runLadderChain + future rung launches
  // read. The handle itself may already be a finished rung (it climbed on), so DON'T require it to
  // be running — the running-only guard is only for plain per-job extends.
  const completionLock = job.completion_lock ?? '';
  const isChainHandle = completionLock.endsWith('.chain.lock');

  if (isChainHandle) {
    const filename = completionLock.split('/').pop() ?? '';
    const sid = filename.replace('.chain.lock', '');
    const chainMeta = sid ? loadChainMeta(sid) : null;
    if (!chainMeta) throw new Error(`Chain ${handle} has no active deadline to extend`);
    const newChainDeadline = Math.max(chainMeta.deadlineAt, now) + seconds * 1000;
    saveChainMeta(sid, { deadlineAt: newChainDeadline });
    // If the handle's own rung is still running, keep its per-job deadline in sync so the watchdog
    // doesn't kill it before the chain budget says so.
    if (job.status === 'running') updateJob(handle, { deadline_at: newChainDeadline });
    return { handle, deadline_at: newChainDeadline };
  }

  // Plain per-job extend (non-ladder worker_run): only meaningful while the job is running.
  if (job.status !== 'running') throw new Error(`Job ${handle} is not running (status: ${job.status})`);
  const newDeadline = Math.max(job.deadline_at ?? 0, now) + seconds * 1000;
  updateJob(handle, { deadline_at: newDeadline });
  return { handle, deadline_at: newDeadline };
}

export function handleCleanup(args: { handle: string }): string {
  return pruneTranscript(args.handle);
}

const WORKER_INSTRUCTIONS = `# worker — delegate coding task to bg agent

1 call = 1 worker. Active → repo working tree; concurrent → own worktree \`worker/<handle>\` off HEAD.

## Rules
- \`worker_ladder\` = DEFAULT. \`worker_run\` only when user names a backend. Params → tool schemas (not repeated here).
- Spec = TARGET: goal/outcome/criteria, NOT files/lines. Worker explores + decides. Give constraints + how-to-verify; leave the how.
- N workers parallel: idle → working tree, active → worktree. New call never kills existing. Cross-process safe.
- Done = ONE commit, no push, no merge — on \`worker/<handle>\` or current branch. \`worker-report <handle>\` = source of truth (diff vs pre-work base). Plain \`git diff\` empty post-commit → use \`git -C <path> show\` or \`diff <base_sha>\`.

## Run loop
1. \`worker_ladder(sid, specFile, dir, timeout?)\` → \`{handle, status:"running"}\`. Returns now; worker runs in bg.
2. Per handle, run \`worker-report <handle>\` in its OWN bg process (Claude Code: Bash run_in_background:true). 1 report = 1 handle, never many. It blocks till that worker ends → bg report = you get notified per worker, main loop stays free. N workers → N bg reports. No sleep-poll, no foreground-block.
3. Report = completion + result in one. Status: completed · failed[:reason] · timeout · stopped · exhausted · killed · stalled. completed/failed/timeout/exhausted/stalled → path + branch + diff; stopped/killed → status only. Near deadline → NEAR_TIMEOUT (decide): \`worker_extend(handle, secs)\` then re-report, or \`worker-report <handle> --wait\` to block to final.
4. Then: completed → review + \`worker_cleanup\`. failed/timeout → inspect + \`worker_resume\`. stopped → \`worker_resume(handle, specFile, dir)\`. exhausted → all backends failed. stalled → chain self-heals. killed → stop.

Other tools self-describe: \`worker_extend\` \`worker_resume\` \`worker_kill\` \`worker_status\` \`worker_list\` \`worker_doctor\` \`worker_cleanup\`.`;

const server = new McpServer(
  { name: 'worker', version: '0.3.0' },
  { instructions: WORKER_INSTRUCTIONS },
);

const bareFilename = (s: string) => !s.includes('/') && !s.includes('\\') && s !== '.' && s !== '..' && !s.includes('..');

server.tool('worker_ladder',
  `Default lane. Run task on bg agent, climbs backend ladder. → {handle, status:'running'} on worker/<handle> or current branch. Spec + report loop → server instructions.`,
  {
    sid: z.string().describe('Session ID ($CLAUDE_CODE_SESSION_ID)'),
    specFile: z.string().min(1).refine(bareFilename, 'bare filename only (no path separators or ..)').describe('Spec filename (bare, no slashes) from ~/.claude/plans/'),
    dir: z.string().min(1).refine(s => s.startsWith('/'), 'absolute path required').describe('Repo directory (absolute path, required)'),
    timeout: z.number().int().min(1).max(3600).optional().describe('Hard timeout seconds (1..3600, default 600)'),
    complex: z.boolean().optional().describe('true=hard; server picks model. Never pass model yourself.'),
  },
  async ({ sid, specFile, dir, timeout, complex }) => {
    const prompt = readSpec(specFile);
    return reply(handleLadder({ sid, prompt, dir, timeout, complex }));
  }
);

server.tool('worker_run',
  `Run task on a named backend — use only when user names one, else worker_ladder. → {handle, status:'running'}. Report loop → server instructions.`,
  {
    backend: z.string().describe('Named backend to run.'),
    specFile: z.string().min(1).refine(bareFilename, 'bare filename only (no path separators or ..)').describe('Spec filename (bare, no slashes) from ~/.claude/plans/'),
    model: z.string().regex(/^[A-Za-z0-9._:-]+$/).optional().describe('Model override. Ignored by workers that pin their own model.'),
    dir: z.string().min(1).refine(s => s.startsWith('/'), 'absolute path required').describe('Repo directory (absolute path, required)'),
    timeout: z.number().int().min(1).max(3600).optional().describe('Hard timeout seconds (1..3600, default 600)'),
    extraArgs: z.array(z.string().max(4096)).optional().describe('Raw worker CLI args.'),
  },
  async ({ backend, ...rest }) => {
    if (!LADDER.includes(backend as Backend)) return reply(`Unknown worker: ${backend}`);
    return reply(handleRun({ backend: backend as Backend, ...rest }));
  }
);

server.tool('worker_resume',
  'Resume stopped worker / retry failed|timeout. Pass original specFile + dir.',
  {
    handle: z.string(),
    specFile: z.string().min(1).refine(bareFilename, 'bare filename only (no path separators or ..)').describe('Spec filename (bare, no slashes) from ~/.claude/plans/'),
    dir: z.string().min(1).refine(s => s.startsWith('/'), 'absolute path required').describe('Repo directory (absolute path, required)'),
    timeout: z.number().int().min(1).max(3600).optional(),
    extraArgs: z.array(z.string().max(4096)).optional().describe('Raw worker CLI args.'),
  },
  async (args) => reply(handleResume(args))
);

server.tool('worker_kill',
  'Kill a running worker.',
  { handle: z.string() },
  async (args) => reply(handleKill(args))
);

server.tool('worker_status',
  'Worker state: status, pid, timing. Not a done-signal — use worker-report to wait for completion.',
  { handle: z.string() },
  async (args) => reply(handleStatus(args))
);

server.tool('worker_extend',
  'Push worker deadline +N sec (1..86400). Repeatable. Unextended → hard-killed ~60s past deadline.',
  {
    handle: z.string().describe('Worker handle'),
    seconds: z.number().describe('Seconds to extend the deadline (1..86400)'),
  },
  async (args) => reply(handleExtend(args))
);

server.tool('worker_doctor',
  'Health check: names broken workers, else all-fine.',
  { backend: z.string().optional() },
  async (args) => reply(handleDoctor(args))
);


server.tool('worker_list',
  'List recent jobs.',
  {
    status: z.string().optional().describe('Filter by status: running|stopped|done|failed|timeout|killed'),
    limit: z.number().optional().describe('Max results (default 20)'),
  },
  async (args) => reply(handleList(args))
);

server.tool('worker_cleanup',
  'Drop transcript (run.log) after diff reviewed. Keeps job.json + worktree + branch. No-op unless worker done.',
  { handle: z.string() },
  async (args) => reply(handleCleanup(args))
);

if (import.meta.main) {
  workerEnv();
  sweepStaleJobs();
  reapStoppedJobs();
  sweepChainLocks();
  pruneOldJobs();
  setInterval(() => { reapStoppedJobs(); sweepStaleJobs(); sweepChainLocks(); pruneOldJobs(); }, 60_000).unref();
  spawnReaper();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.on('end', shutdown);
}
