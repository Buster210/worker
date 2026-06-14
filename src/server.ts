import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';

import {
  getJob, updateJob, finalizeJob, getAllJobs, pruneOldJobs,
} from './state.ts';
import { LADDER, ALL_BACKENDS, type Backend } from './backends.ts';
import { backendShellArgv } from './runner.ts';
import { workerEnv } from './env.ts';
import { resolveStatus } from './status.ts';
import { isProcessAlive } from './process.ts';
import { sweepStaleJobs, reapStoppedJobs } from './maintenance.ts';
import { launch, forceKillJob, assertRepo, resumeLaunch as lifecycleResumeLaunch, shutdown } from './lifecycle.ts';
import { handleLadder } from './chain.ts';

// --- MCP tool handlers (keep in server.ts) ---

export function reply(r: unknown) {
  const text = typeof r === 'string' ? r : JSON.stringify(r);
  return { content: [{ type: 'text' as const, text }] };
}

export function handleRun(args: { backend: Backend; prompt: string; model?: string; dir: string; timeout?: number; extraArgs?: string[] }): { handle: string; status: string } {
  assertRepo(args.dir);
  const sid = randomUUID();
  const { handle, promise } = launch(args.backend, args.prompt, args.dir,
    { sid, model: args.model, extraArgs: args.extraArgs, timeoutMs: args.timeout ? args.timeout * 1000 : undefined });
  void promise.catch(() => {});
  return { handle, status: 'running' };
}

export function handleResume(args: { handle: string; prompt: string; dir: string; timeout?: number; extraArgs?: string[] }): { handle: string; status: string } {
  const { handle, promise } = lifecycleResumeLaunch(args);
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
  if (job.backend === 'claude_tmux') {
    forceKillJob(job);
    const final = finalizeJob(handle, resolveStatus(job.backend, 0, job.log_path, false));
    return `killed: ${handle} (${final})`;
  }
  if (job.status === 'stopped' && job.worker_pid) {
    forceKillJob(job);
    const final = finalizeJob(handle, resolveStatus(job.backend, 0, job.log_path, false));
    return `killed: ${handle} (${final})`;
  }
  if (job.worker_pid) {
    try { process.kill(-job.worker_pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(-job.worker_pid, 'SIGKILL'); } catch {} }, 3_000);
  }
  if (!isProcessAlive(job.worker_pid, job.started)) {
    const final = finalizeJob(handle, resolveStatus(job.backend, 0, job.log_path, false));
    return `killed: ${handle} (${final})`;
  }
  return `killed: ${handle}`;
}

export function handleStatus(args: { handle: string }): Record<string, unknown> {
  const { handle } = args;
  const job = getJob(handle);
  if (!job) throw new Error(`No job found: ${handle}`);
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
    const r = spawnSync(cmd, probeArgs, { stdio: 'ignore', env: workerEnv, timeout: 10_000 });
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

const WORKER_INSTRUCTIONS = `# worker — delegate a coding task to a background agent

Hand a coding task to a background agent that edits a repo, then check, resume, and report on it. One task = one running worker.

## Rules
- \`worker_ladder(sid, prompt, dir)\` is the DEFAULT — use it for every task. \`worker_run\` only when the user names a specific worker.
- \`dir\` is REQUIRED on every call — the absolute repo path.
- \`sid\` = your session id (e.g. \$CLAUDE_CODE_SESSION_ID).
- ONE worker per repo at a time — a new call on a busy repo replaces the one already there.
- Read a worker's output from git: \`git -C <dir> diff\`.

## Run a task
1. Call \`worker_ladder(sid, prompt, dir)\`. It returns at once: \`{ handle, status:"running" }\`, then works in the background — it keeps trying until the task is done or no worker can do it. You don't drive it.
2. Wait for completion in the BACKGROUND — run (just the handle):
       worker-report <handle>
  When the job ends it prints one bundle to stdout:
       line 1 = outcome — one of: completed · failed[:reason] · timeout · stopped · exhausted · killed
       completed / failed / timeout / exhausted → blank line, then the full \`git diff\`
       stopped / killed → just the one line
  This bundle is your completion signal AND the result — don't also run \`git diff\` / \`worker_status\`.
3. Act on the outcome:
  - \`completed\` → review the diff against the spec.
  - \`failed\` / \`timeout\` → inspect the diff; \`worker_resume\` to retry, or report.
  - \`stopped\` → the worker paused with its work preserved; \`worker_resume(handle, prompt, dir)\` to finish it.
  - \`exhausted\` → no worker could do it; report and stop.
  - \`killed\` → stop.

## Other tools
- \`worker_resume(handle, prompt, dir)\` — continue a \`stopped\` worker, or retry a \`failed\`/\`timeout\` one.
- \`worker_kill(handle)\` — stop a running worker.
- \`worker_status(handle)\` — mid-run check only; never your completion signal (use the report command above).
- \`worker_list(status?, limit?)\` — recent jobs. Optionally filter by status.
- \`worker_doctor(backend?)\` — health check; names only the workers that aren't working.`;

const server = new McpServer(
  { name: 'worker', version: '0.2.0' },
  { instructions: WORKER_INSTRUCTIONS },
);

server.tool('worker_ladder',
  `DEFAULT way to run a coding task: hands it to a background agent that edits the repo and runs it to completion on its own, until the task is done or no worker can do it. Returns at once { handle, status:"running" }; get the result via the report command \`bun report.ts <handle>\` (see instructions).`,
  {
    sid: z.string().describe('Session ID ($CLAUDE_CODE_SESSION_ID)'),
    prompt: z.string().describe('Task spec'),
    dir: z.string().describe('Repo directory (absolute path, required)'),
    timeout: z.number().optional().describe('Hard timeout seconds (default 600)'),
  },
  async (args) => reply(handleLadder(args))
);

server.tool('worker_run',
  `Run a coding task on a SPECIFIC worker — only when the user explicitly names one; otherwise use worker_ladder. Returns at once { handle, status:"running" }; get the result via the report command \`bun report.ts <handle>\` (see instructions).`,
  {
    backend: z.string().describe('The specific worker to run (default to worker_ladder unless the user named one).'),
    prompt: z.string(),
    model: z.string().optional().describe('Model override. Ignored by workers that pin their own model.'),
    dir: z.string().describe('Repo directory (absolute path, required)'),
    timeout: z.number().optional().describe('Hard timeout seconds (default 600)'),
    extraArgs: z.array(z.string()).optional().describe('Raw extra args forwarded verbatim to the worker. Omit unless you know the worker CLI.'),
  },
  async ({ backend, ...rest }) => {
    if (!LADDER.includes(backend as Backend)) return reply(`Unknown worker: ${backend}`);
    return reply(handleRun({ backend: backend as Backend, ...rest }));
  }
);

server.tool('worker_resume',
  'Continue a stopped worker, or retry a failed/timeout one.',
  {
    handle: z.string(),
    prompt: z.string(),
    dir: z.string().describe('Repo directory (absolute path, required)'),
    timeout: z.number().optional(),
    extraArgs: z.array(z.string()).optional().describe('Raw extra args forwarded to the worker.'),
  },
  async (args) => reply(handleResume(args))
);

server.tool('worker_kill',
  'Stop a running worker by handle.',
  { handle: z.string() },
  async (args) => reply(handleKill(args))
);

server.tool('worker_status',
  'Check a running worker mid-task. Not a completion signal — use the report command.',
  { handle: z.string() },
  async (args) => reply(handleStatus(args))
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
  sweepStaleJobs();
  reapStoppedJobs();
  pruneOldJobs();
  setInterval(() => { reapStoppedJobs(); sweepStaleJobs(); }, 60_000).unref();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.on('end', shutdown);
}