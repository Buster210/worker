import { basename } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import http from 'http';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
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
import {
  acquireLock, readLock, removeLock, isDaemonAlive, SessionTracker,
  killSessionWorkers, hardShutdown, startKeepalive,
} from './daemon.ts';

// --- MCP tool handlers (keep in server.ts) ---

export function reply(r: unknown) {
  const text = typeof r === 'string' ? r : JSON.stringify(r);
  return { content: [{ type: 'text' as const, text }] };
}

export function handleRun(args: { backend: Backend; specFile: string; model?: string; dir: string; timeout?: number; extraArgs?: string[] }, mcpSid: string = randomUUID()): { handle: string; status: string } {
  assertRepo(args.dir);
  const prompt = readSpec(args.specFile);
  const { handle, promise } = launch(args.backend, prompt, args.dir,
    { mcpSid, model: args.model, extraArgs: args.extraArgs, timeoutMs: args.timeout ? args.timeout * 1000 : undefined });
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
  const backends = args.backend ? [args.backend] : [...ALL_BACKENDS];
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
1. \`worker_ladder(specFile, dir, timeout?)\` → \`{handle, status:"running"}\`. Returns now; worker runs in bg.
2. Per handle, run \`worker-report <handle>\` in its OWN bg process (Claude Code: Bash run_in_background:true). 1 report = 1 handle, never many. It blocks till that worker ends → bg report = you get notified per worker, main loop stays free. N workers → N bg reports. No sleep-poll, no foreground-block.
3. Report = completion + result in one. Status: completed · failed[:reason] · timeout · stopped · exhausted · killed · stalled. completed/failed/timeout/exhausted/stalled → path + branch + diff; stopped/killed → status only. Near deadline → NEAR_TIMEOUT (decide): \`worker_extend(handle, secs)\` then re-report, or \`worker-report <handle> --wait\` to block to final.
4. Then: completed → review + \`worker_cleanup\`. failed/timeout → inspect + \`worker_resume\`. stopped → \`worker_resume(handle, specFile, dir)\`. exhausted → all backends failed. stalled → chain self-heals. killed → stop.

Other tools self-describe: \`worker_extend\` \`worker_resume\` \`worker_kill\` \`worker_status\` \`worker_list\` \`worker_doctor\` \`worker_cleanup\`.`;

/** Create a fresh McpServer with all worker tools registered. */
export function createWorkerServer(tracker?: SessionTracker): McpServer {
  const s = new McpServer(
    { name: 'worker', version: '0.3.0' },
    { instructions: WORKER_INSTRUCTIONS },
  );

  const bareFilename = (v: string) => !v.includes('/') && !v.includes('\\') && v !== '.' && v !== '..' && !v.includes('..');

  s.registerTool('worker_ladder', {
    description: `Default lane. Run task on bg agent, climbs backend ladder. → {handle, status:'running'} on worker/<handle> or current branch. Spec + report loop → server instructions.`,
    inputSchema: {
      specFile: z.string().min(1).refine(bareFilename, 'bare filename only (no path separators or ..)').describe('Spec filename (bare, no slashes) from ~/.claude/plans/'),
      dir: z.string().min(1).refine(v => v.startsWith('/'), 'absolute path required').describe('Repo directory (absolute path, required)'),
      timeout: z.number().int().min(1).max(3600).optional().describe('Hard timeout seconds (1..3600, default 600)'),
      complex: z.boolean().optional().describe('true=hard; server picks model. Never pass model yourself.'),
    },
  }, async ({ specFile, dir, timeout, complex }, extra) => {
      const mcpSid = (extra.sessionId as string | undefined) || process.env.CLAUDE_CODE_SESSION_ID || randomUUID();
      const prompt = readSpec(specFile);
      return reply(handleLadder({ mcpSid, prompt, dir, timeout, complex }));
    }
  );

  s.registerTool('worker_run', {
    description: `Run task on a named backend — use only when user names one, else worker_ladder. → {handle, status:'running'}. Report loop → server instructions.`,
    inputSchema: {
      backend: z.string().describe('Named backend to run.'),
      specFile: z.string().min(1).refine(bareFilename, 'bare filename only (no path separators or ..)').describe('Spec filename (bare, no slashes) from ~/.claude/plans/'),
      model: z.string().regex(/^[A-Za-z9._:-]+$/).optional().describe('Model override. Ignored by workers that pin their own model.'),
      dir: z.string().min(1).refine(v => v.startsWith('/'), 'absolute path required').describe('Repo directory (absolute path, required)'),
      timeout: z.number().int().min(1).max(3600).optional().describe('Hard timeout seconds (1..3600, default 600)'),
      extraArgs: z.array(z.string().max(4096)).optional().describe('Raw worker CLI args.'),
    },
  }, async ({ backend, ...rest }, extra) => {
      const mcpSid = (extra.sessionId as string | undefined) || process.env.CLAUDE_CODE_SESSION_ID || randomUUID();
      if (!LADDER.includes(backend as Backend)) return reply(`Unknown worker: ${backend}`);
      return reply(handleRun({ backend: backend as Backend, ...rest }, mcpSid));
    }
  );

  s.registerTool('worker_resume', {
    description: 'Resume stopped worker / retry failed|timeout. Pass original specFile + dir.',
    inputSchema: {
      handle: z.string(),
      specFile: z.string().min(1).refine(bareFilename, 'bare filename only (no path separators or ..)').describe('Spec filename (bare, no slashes) from ~/.claude/plans/'),
      dir: z.string().min(1).refine(v => v.startsWith('/'), 'absolute path required').describe('Repo directory (absolute path, required)'),
      timeout: z.number().int().min(1).max(3600).optional(),
      extraArgs: z.array(z.string().max(4096)).optional().describe('Raw worker CLI args.'),
    },
  }, async (args) => reply(handleResume(args))
  );

  s.registerTool('worker_kill', {
    description: 'Kill a running worker.',
    inputSchema: { handle: z.string() },
  }, async (args) => reply(handleKill(args))
  );

  s.registerTool('worker_status', {
    description: 'Worker state: status, pid, timing. Not a done-signal — use worker-report to wait for completion.',
    inputSchema: { handle: z.string() },
  }, async (args) => reply(handleStatus(args))
  );

  s.registerTool('worker_extend', {
    description: 'Push worker deadline +N sec (1..86400). Repeatable. Unextended → hard-killed ~60s past deadline.',
    inputSchema: {
      handle: z.string().describe('Worker handle'),
      seconds: z.number().describe('Seconds to extend the deadline (1..86400)'),
    },
  }, async (args) => reply(handleExtend(args))
  );

  s.registerTool('worker_doctor', {
    description: 'Health check: names broken workers, else all-fine.',
    inputSchema: { backend: z.string().optional() },
  }, async (args) => reply(handleDoctor(args))
  );

  s.registerTool('worker_list', {
    description: 'List recent jobs.',
    inputSchema: {
      status: z.string().optional().describe('Filter by status: running|stopped|done|failed|timeout|killed'),
      limit: z.number().optional().describe('Max results (default 20)'),
    },
  }, async (args) => reply(handleList(args))
  );

  s.registerTool('worker_cleanup', {
    description: 'Drop transcript (run.log) after diff reviewed. Keeps job.json + worktree + branch. No-op unless worker done.',
    inputSchema: { handle: z.string() },
  }, async (args) => reply(handleCleanup(args))
  );
  return s;
}

function initDaemon(): void {
  workerEnv();
  sweepStaleJobs();
  reapStoppedJobs();
  sweepChainLocks();
  pruneOldJobs();
  setInterval(() => { reapStoppedJobs(); sweepStaleJobs(); sweepChainLocks(); pruneOldJobs(); }, 60_000).unref();
  spawnReaper();
}

if (import.meta.main) {
  initDaemon();
  // --- HTTP daemon mode ---
  const tracker = new SessionTracker();
  // Grace before idle teardown: onclose fires on transient SSE drops too, so a
  // blip must not exit the daemon. Linger, and cancel if a session reconnects.
  let shutdownTimer: NodeJS.Timeout | null = null;
  const SHUTDOWN_GRACE_MS = 10_000;

  const httpServer = http.createServer(async (req, res) => {
    // Health endpoint
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: tracker.size, uptime: process.uptime() }));
      return;
    }

    // MCP endpoint
    if (req.url === '/mcp') {
      let body = '';
      for await (const chunk of req) body += chunk;

      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId) {
        const entry = tracker.get(sessionId);
        if (entry) {
          // Existing session — route to its transport (DELETE has no body)
          const parsed = body ? JSON.parse(body) : undefined;
          await entry.transport.handleRequest(req, res, parsed);
          return;
        }
      }

      if (!sessionId && req.method === 'POST') {
        const parsed: unknown = JSON.parse(body);
        if (isInitializeRequest(parsed)) {
          // New session — create transport + server
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
          });
          const server = createWorkerServer(tracker);

          // Wire close handler before connect — fires on disconnect (clean or broken SSE)
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) {
              tracker.remove(sid);
              killSessionWorkers(sid);
              if (tracker.size === 0) {
                // Don't exit on a transient drop — linger; a reconnect cancels this.
                shutdownTimer = setTimeout(() => {
                  if (tracker.size === 0) hardShutdown();
                }, SHUTDOWN_GRACE_MS);
                shutdownTimer.unref();
              }
            }
          };

          await server.connect(transport);
          await transport.handleRequest(req, res, parsed);

          // Transport now has a session ID — register with tracker
          const mcpSid = transport.sessionId;
          if (mcpSid) {
            if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
            tracker.register(mcpSid, { transport, server });
          }
          return;
        }
      }

      // Invalid request
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request' }, id: null }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  // Try to bind. If port occupied, check if it's our daemon.
  const port = process.env.WORKER_PORT ? Number(process.env.WORKER_PORT) : 54321;
  httpServer.on('error', async (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      const existing = readLock();
      if (existing && await isDaemonAlive(existing)) {
        console.error(`Daemon already running on port ${existing.port} (PID ${existing.pid}). Reusing.`);
        process.exit(0);
      }
      // Stale or foreign process — try to reclaim
      console.error(`Port ${port} occupied. Removing stale lockfile and retrying...`);
      removeLock();
      httpServer.listen(port);
    } else {
      console.error('HTTP server error:', err);
      process.exit(1);
    }
  });

  httpServer.listen(port, () => {
    const actualPort = (httpServer.address() as { port: number }).port;
    if (!acquireLock(process.pid, actualPort)) {
      console.error('Failed to acquire lockfile. Another daemon may have started.');
      httpServer.close();
      process.exit(1);
    }
    console.error(`Worker daemon listening on http://127.0.0.1:${actualPort}/mcp`);
    startKeepalive(tracker);
  });

  const gracefulShutdown = () => { hardShutdown(); };
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}
