import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import {
  getJob, updateJob, finalizeJob, getAllJobs, pruneOldJobs, readSpec, loadChainMeta, saveChainMeta,
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
    return { status: running ? 'running' : terminalStatus(handle, cl), alive: running, started: job.started };
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

const WORKER_INSTRUCTIONS = `# worker — delegate a coding task to a background agent

Hand a coding task to a background agent that edits a repo, then check, resume, and report on it. One call = one background worker, isolated in its own git worktree.

## Rules
- \`worker_ladder(sid, specFile, dir, timeout?)\` is the DEFAULT — use it for every task. \`worker_run\` only when the user names a specific worker.
- \`dir\` is REQUIRED on every call — the absolute repo path.
- \`specFile\` is a BARE filename (no slashes); spec files live in \`~/.claude/plans/\`. The server reads the file and uses its content as the task spec.
- \`sid\` = your session id (e.g. \$CLAUDE_CODE_SESSION_ID).
- \`timeout\` = optional hard timeout in seconds (1..3600, default 600). The chain deadline; if exceeded, the job ends with \`timeout\` status.
- N workers can run in PARALLEL on the same repo — each is isolated in its own git worktree on branch \`worker/<handle>\`. A new call does NOT kill an existing one.
- On a completed (green) run the worker makes ONE atomic commit on its own \`worker/<handle>\` branch (never pushes, never merges). The authoritative result is the \`worker-report <handle>\` bundle (full diff vs the pre-work base already included). To read git directly, use \`git -C <worktree_path> show\` or \`git -C <worktree_path> diff <base_sha>\` — a plain \`git diff\` will be empty after the commit.

## Run a task
1. Call \`worker_ladder(sid, specFile, dir, timeout?)\`. It returns at once: \`{ handle, status:"running" }\`, then works in the background — it keeps trying until the task is done or no worker can do it. You don't drive it.
2. Wait for completion in the BACKGROUND — run (just the handle):
       worker-report <handle>
  This command BLOCKS until the job finishes. It polls the job's lock file, so it won't return until the chain completes. When done it prints one bundle to stdout:
       line 1 = status — one of: completed · failed[:reason] · timeout · stopped · exhausted · killed · stalled
       completed / failed / timeout / exhausted / stalled → worktree path, branch, then the full \`git diff\`
       stopped / killed → just the status line
  If the job is still running and near its deadline, it prints a NEAR_TIMEOUT line instead of blocking. Two choices: \`worker_extend(handle, secs)\` then re-run \`worker-report <handle>\` to keep waiting; OR \`worker-report <handle> --wait\` to ignore the signal and block straight through to the terminal report (the worker is hard-killed at the grace edge and you get its \`timeout\` bundle). Don't poll with a fixed \`sleep\` — the near-timeout window is ~30s wide on each side of the deadline, so a short sleep can just re-trip the same signal.
  This bundle is your completion signal AND the result — don't also run \`git diff\` / \`worker_status\`.
3. Act on the outcome:
  - \`completed\` → review the diff against the spec.
  - \`failed\` / \`timeout\` → inspect the diff; \`worker_resume\` to retry, or report.
  - \`stopped\` → the worker paused with its work preserved; \`worker_resume(handle, specFile, dir)\` to finish it.
  - \`exhausted\` → all backends tried with no success; report and stop.
  - \`stalled\` → worker hung (no activity). The chain auto-retries once on the same backend, then climbs to the next. If you see this in the report, the chain already handled it.
  - \`killed\` → stop.

## Other tools
- \`worker_extend(handle, seconds)\` — push a running worker's deadline out by \`seconds\` (1..86400). Repeatable. The deadline is soft within a grace window: ~30s before it the report emits \`NEAR_TIMEOUT\` so you can extend; if nobody extends, the worker is hard-killed (status \`timeout\`) ~60s past the deadline.
- \`worker_resume(handle, specFile, dir)\` — continue a \`stopped\` worker, or retry a \`failed\`/\`timeout\` one. \`specFile\` is a bare filename in \`~/.claude/plans/\`.
- \`worker_kill(handle)\` — stop a running worker.
- \`worker_status(handle)\` — mid-run check; returns the current job state. Not your completion signal — use \`worker-report\` which blocks until done.
- \`worker_list(status?, limit?)\` — recent jobs. Optionally filter by status.
- \`worker_doctor(backend?)\` — health check; names only the workers that aren't working.`;

const server = new McpServer(
  { name: 'worker', version: '0.2.0' },
  { instructions: WORKER_INSTRUCTIONS },
);

const bareFilename = (s: string) => !s.includes('/') && !s.includes('\\') && s !== '.' && s !== '..' && !s.includes('..');

server.tool('worker_ladder',
  `DEFAULT way to run a coding task: hands it to a background agent that edits the repo and runs it to completion on its own, until the task is done or no worker can do it. Pass \`specFile\` (bare filename in ~/.claude/plans/) + \`dir\` (absolute repo path) + optional \`timeout\` (seconds, default 600). Returns at once { handle, status:"running" }; get the result via the report command \`bun report.ts <handle>\` (see instructions).`,
  {
    sid: z.string().describe('Session ID ($CLAUDE_CODE_SESSION_ID)'),
    specFile: z.string().min(1).refine(bareFilename, 'bare filename only (no path separators or ..)').describe('Spec filename (bare, no slashes) from ~/.claude/plans/'),
    dir: z.string().min(1).refine(s => s.startsWith('/'), 'absolute path required').describe('Repo directory (absolute path, required)'),
    timeout: z.number().int().min(1).max(3600).optional().describe('Hard timeout seconds (1..3600, default 600)'),
  },
  async ({ sid, specFile, dir, timeout }) => {
    const prompt = readSpec(specFile);
    return reply(handleLadder({ sid, prompt, dir, timeout }));
  }
);

server.tool('worker_run',
  `Run a coding task on a SPECIFIC worker — only when the user explicitly names one; otherwise use worker_ladder. Pass \`specFile\` (bare filename in ~/.claude/plans/) + \`dir\` (absolute repo path). Returns at once { handle, status:"running" }; get the result via the report command \`bun report.ts <handle>\` (see instructions).`,
  {
    backend: z.string().describe('The specific worker to run (default to worker_ladder unless the user named one).'),
    specFile: z.string().min(1).refine(bareFilename, 'bare filename only (no path separators or ..)').describe('Spec filename (bare, no slashes) from ~/.claude/plans/'),
    model: z.string().regex(/^[A-Za-z0-9._:-]+$/).optional().describe('Model override. Ignored by workers that pin their own model.'),
    dir: z.string().min(1).refine(s => s.startsWith('/'), 'absolute path required').describe('Repo directory (absolute path, required)'),
    timeout: z.number().int().min(1).max(3600).optional().describe('Hard timeout seconds (1..3600, default 600)'),
    extraArgs: z.array(z.string().max(4096)).optional().describe('Raw extra args forwarded verbatim to the worker. Omit unless you know the worker CLI.'),
  },
  async ({ backend, ...rest }) => {
    if (!LADDER.includes(backend as Backend)) return reply(`Unknown worker: ${backend}`);
    return reply(handleRun({ backend: backend as Backend, ...rest }));
  }
);

server.tool('worker_resume',
  'Continue a stopped worker, or retry a failed/timeout one. Pass the same specFile (bare filename in ~/.claude/plans/) used when the job was started.',
  {
    handle: z.string(),
    specFile: z.string().min(1).refine(bareFilename, 'bare filename only (no path separators or ..)').describe('Spec filename (bare, no slashes) from ~/.claude/plans/'),
    dir: z.string().min(1).refine(s => s.startsWith('/'), 'absolute path required').describe('Repo directory (absolute path, required)'),
    timeout: z.number().int().min(1).max(3600).optional(),
    extraArgs: z.array(z.string().max(4096)).optional().describe('Raw extra args forwarded to the worker.'),
  },
  async (args) => reply(handleResume(args))
);

server.tool('worker_kill',
  'Stop a running worker by handle.',
  { handle: z.string() },
  async (args) => reply(handleKill(args))
);

server.tool('worker_status',
  'Check a worker\'s current state. Returns status, pid, timing, etc. Not a completion signal — use `worker-report <handle>` which blocks until done.',
  { handle: z.string() },
  async (args) => reply(handleStatus(args))
);

server.tool('worker_extend',
  'Push a running worker\'s deadline out by N seconds (1..86400). Repeatable. The deadline is soft within a grace window (~30s pre-deadline NEAR_TIMEOUT warning), but if nobody extends, the worker is hard-killed (status "timeout") ~60s past the deadline.',
  {
    handle: z.string().describe('Worker handle'),
    seconds: z.number().describe('Seconds to extend the deadline (1..86400)'),
  },
  async (args) => reply(handleExtend(args))
);

server.tool('worker_doctor',
  'Report worker health — names only the workers that are not operational; otherwise confirms all are fine.',
  { backend: z.string().optional() },
  async (args) => reply(handleDoctor(args))
);


server.tool('worker_list',
  'List recent worker jobs. Optionally filter by status.',
  {
    status: z.string().optional().describe('Filter by status: running|stopped|done|failed|timeout|killed'),
    limit: z.number().optional().describe('Max results (default 20)'),
  },
  async (args) => reply(handleList(args))
);

if (import.meta.main) {
  workerEnv();
  sweepStaleJobs();
  reapStoppedJobs();
  sweepChainLocks();
  pruneOldJobs();
  setInterval(() => { reapStoppedJobs(); sweepStaleJobs(); sweepChainLocks(); }, 60_000).unref();
  spawnReaper();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.on('end', shutdown);
}
