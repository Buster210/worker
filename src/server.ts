import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { spawnSync, execSync } from 'child_process';
import { insertJob, getJob, updateJob, createLock, removeLock, WORKERS_DIR, lockPath, logPath as workerLogPath, finalizeJob, getRunningJobsForRepo } from './state.ts';
import { buildSpec, buildRunArgv, buildResumeArgv, getResumeToken, type Backend } from './backends.ts';
import {
  runWorker, runClaudeTmux, trackJob, waitJob, sweepStaleJobs, workerEnv,
  isProcessAlive, resolveStatus, suspendAndEval, DEFAULT_TIMEOUT_MS, type RunResult,
} from './runner.ts';
import { ladderNext, recordLadder } from './ladder.ts';

function killJobHard(job: { handle: string; backend: string; worker_pid: number; log_path: string }): void {
  updateJob(job.handle, { kill_requested: true });
  if (job.backend === 'claude_tmux') {
    try { spawnSync('tmux', ['kill-session', '-t', job.handle], { stdio: 'ignore' }); } catch {}
  } else if (job.worker_pid > 0) {
    try { process.kill(-job.worker_pid, 'SIGKILL'); } catch {}
  }
}

function newHandle(backend: Backend): string {
  const id = randomUUID();
  // Only claude consumes a full --session-id; everything else (incl. omp, which keys
  // resume off a per-job --session-dir) uses the short w- handle.
  return backend === 'claude' ? id : `w-${id.slice(0, 8)}`;
}

function assertRepo(dir: string) {
  try { 
    const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: 'ignore' });
    if (result.status !== 0) throw new Error('not a git repo');
  }
  catch { throw new Error(`Not a git repo: ${dir}`); }
}

const server = new McpServer({ name: 'worker', version: '0.1.0' });

server.tool('worker_ladder',
  'Run a coding task via the worker ladder (default). Auto-routes omp→opencode→pool→cmd→claude→claude_tmux. Use climb=true to escalate after a failed run.',
  {
    sid: z.string().describe('Session ID ($CLAUDE_CODE_SESSION_ID)'),
    prompt: z.string().describe('Task spec'),
    climb: z.boolean().optional().describe('Advance to next rung'),
    dir: z.string().describe('Repo directory (absolute path, required)'),
    timeout: z.number().optional().describe('Hard timeout seconds (default 600)'),
  },
  async ({ sid, prompt, climb, dir, timeout }) => {
    assertRepo(dir);
    const next = ladderNext(sid, climb ?? false);
    if (!next) {
      const result = JSON.stringify({ status: 'exhausted', worker: null, note: 'all backends exhausted' });
      return { content: [{ type: 'text', text: result }] };
    }
    const { backend, turn } = next;
    const handle = newHandle(backend);
    // Kill lingering same-repo jobs
    for (const job of getRunningJobsForRepo(dir)) {
      killJobHard(job);
      finalizeJob(job.handle, 'killed');
    }
    const lp = workerLogPath(handle, dir);
    const spec = buildSpec(backend, prompt);
    insertJob({ handle, backend, sid, repo: dir, task: prompt, log_path: lp });
    if (backend === 'claude_tmux') {
      const p = runClaudeTmux(spec, dir, handle, handle, timeout ? timeout * 1000 : undefined)
        .then(r => { recordLadder(sid, turn, 'claude_tmux', r.status); return r; });
      trackJob(handle, p);
      return { content: [{ type: 'text', text: JSON.stringify({ handle, status: 'running', lock_path: lockPath(handle, dir) }) }] };
    }
    const argv = buildRunArgv(backend, spec, dir, handle, undefined);
    const initToken = backend === 'opencode' ? '' : getResumeToken(backend, handle, lp);
    const p = runWorker(argv, dir, handle, backend, lp,
      initToken, timeout ? timeout * 1000 : undefined)
      .then(r => {
        if (backend === 'opencode') {
          const tok = getResumeToken('opencode', handle, lp);
          if (tok) { r.resume_token = tok; updateJob(handle, { resume_token: tok }); }
        }
        recordLadder(sid, turn, backend, r.status);
        return r;
      });
    trackJob(handle, p);
    return { content: [{ type: 'text', text: JSON.stringify({ handle, status: 'running', lock_path: lockPath(handle, dir) }) }] };
  }
);

server.tool('worker_run',
  'Run on a specific backend. Only when user explicitly names one.',
  {
    backend: z.enum(['pool', 'omp', 'opencode', 'cmd', 'claude', 'claude_tmux']),
    prompt: z.string(),
    model: z.string().optional(),
    dir: z.string().describe('Repo directory (absolute path, required)'),
    timeout: z.number().optional(),
    extraArgs: z.array(z.string()).optional().describe('Raw extra args forwarded to backend binary (-- passthrough)'),
  },
  async ({ backend, prompt, model, dir, timeout, extraArgs }) => {
    assertRepo(dir);
    const be = backend as Backend;
    const sid = randomUUID();
    const handle = newHandle(be);
    // Kill lingering same-repo jobs
    for (const job of getRunningJobsForRepo(dir)) {
      killJobHard(job);
      finalizeJob(job.handle, 'killed');
    }
    const lp = workerLogPath(handle, dir);
    const spec = buildSpec(be, prompt);
    if (be === 'claude_tmux') {
      insertJob({ handle, backend: be, sid, repo: dir, task: prompt, log_path: lp });
      const p = runClaudeTmux(spec, dir, handle, handle, timeout ? timeout * 1000 : undefined);
      trackJob(handle, p);
      return { content: [{ type: 'text', text: JSON.stringify({ handle, status: 'running', lock_path: lockPath(handle, dir) }) }] };
    }
    // claude pins sonnet; omp ignores model entirely. Neither threads the model parameter.
    const modelToUse = (be === 'claude' || be === 'omp') ? undefined : model;
    const argv = buildRunArgv(be, spec, dir, handle, modelToUse, extraArgs);
    insertJob({ handle, backend: be, sid, repo: dir, model: modelToUse, task: prompt, log_path: lp });
    const initToken = be === 'opencode' ? '' : getResumeToken(be, handle, lp);
    const p = runWorker(argv, dir, handle, be, lp,
      initToken, timeout ? timeout * 1000 : undefined)
      .then(r => {
        if (be === 'opencode') {
          const tok = getResumeToken('opencode', handle, lp);
          if (tok) { r.resume_token = tok; updateJob(handle, { resume_token: tok }); }
        }
        return r;
      });
    trackJob(handle, p);
    return { content: [{ type: 'text', text: JSON.stringify({ handle, status: 'running', lock_path: lockPath(handle, dir) }) }] };
  }
);

server.tool('worker_resume',
  'Resume a previous worker run.',
  {
    handle: z.string(),
    prompt: z.string(),
    dir: z.string().describe('Repo directory (absolute path, required)'),
    timeout: z.number().optional(),
    extraArgs: z.array(z.string()).optional().describe('Raw extra args forwarded to backend binary (-- passthrough)'),
  },
  async ({ handle, prompt, dir, timeout, extraArgs }) => {
    const job = getJob(handle);
    if (!job) throw new Error(`No job found for handle: ${handle}`);
    updateJob(handle, { kill_requested: false });
    
    // Handle stopped jobs: SIGCONT the process, re-arm fresh timeout
    if (job.status === 'stopped') {
      const pid = job.worker_pid;
      // Check if process is still alive (it should be frozen with SIGSTOP)
      if (!isProcessAlive(pid, job.started)) {
        // Process is dead (race condition) - fall back to token-respawn
        const be = job.backend as Backend;
        const lp = workerLogPath(handle);
        const spec = buildSpec(be, prompt);
        const argv = buildResumeArgv(be, spec, dir, job.resume_token, undefined, extraArgs);
        const p = runWorker(argv, dir, handle, be, lp,
          job.resume_token, timeout ? timeout * 1000 : undefined);
        trackJob(handle, p);
        return { content: [{ type: 'text', text: JSON.stringify({ handle, status: 'running', lock_path: lockPath(handle) }) }] };
      }
      
      // Resume the frozen process: SIGCONT, re-arm a fresh hard timeout.
      try { process.kill(-pid, 'SIGCONT'); } catch {}
      updateJob(handle, { status: 'running' });
      createLock(handle);

      const be = job.backend as Backend;
      const lp = workerLogPath(handle);
      const deadlineMs = timeout ? timeout * 1000 : DEFAULT_TIMEOUT_MS;
      const resumeStart = Date.now();

      const resumePromise = new Promise<RunResult>((resolve) => {
        const mkResult = (status: string): RunResult => ({
          status, exit_code: 0, backend: be, handle,
          resume_token: job.resume_token, repo: dir, shortstat: '', log: lp,
        });
        const check = () => {
          // Process exited on its own → finalize from log.
          if (!isProcessAlive(pid, job.started)) {
            const status = finalizeJob(handle, resolveStatus(be, 0, lp, false));
            resolve(mkResult(status));
            return;
          }
          // Re-armed timeout fired → suspend again (stopped) or kill (terminal).
          if (Date.now() - resumeStart >= deadlineMs) {
            if (suspendAndEval(handle, pid, lp)) {
              resolve(mkResult('stopped')); // suspendAndEval already persisted 'stopped' + removed lock
            } else {
              const status = finalizeJob(handle, resolveStatus(be, 124, lp, true));
              resolve(mkResult(status));
            }
            return;
          }
          setTimeout(check, 1000);
        };
        check();
      });

      trackJob(handle, resumePromise);
      return { content: [{ type: 'text', text: JSON.stringify({ handle, status: 'running', lock_path: lockPath(handle) }) }] };
    }
    
    // Normal resume for non-stopped jobs
    const be = job.backend as Backend;
    const lp = workerLogPath(handle);
    let spec = buildSpec(be, prompt);
    if (be === 'cmd') {
      spec = `A prior attempt already ran in this repo — inspect the working tree, determine what is already done, and complete only the remainder.\n\n` + spec;
    }
    const argv = buildResumeArgv(be, spec, dir, job.resume_token, undefined, extraArgs);
    const p = runWorker(argv, dir, handle, be, lp,
      job.resume_token, timeout ? timeout * 1000 : undefined);
    trackJob(handle, p);
    return { content: [{ type: 'text', text: JSON.stringify({ handle, status: 'running', lock_path: lockPath(handle) }) }] };
  }
);

server.tool('worker_kill',
  'Kill a running worker by handle.',
  { handle: z.string() },
  async ({ handle }) => {
    const job = getJob(handle);
    if (!job) throw new Error(`No job found: ${handle}`);
    // Already terminal — nothing to do
    const TERMINAL = /^(done|failed|timeout|killed)/;
    if (TERMINAL.test(job.status)) {
      return { content: [{ type: 'text', text: `already ${job.status}` }] };
    }
    // Mark intent up front so the completion path (or finalize below) derives 'killed', not 'failed'.
    updateJob(handle, { kill_requested: true });
    // claude_tmux: kill session and finalize immediately (no live pid → no tracked finalize otherwise)
    if (job.backend === 'claude_tmux') {
      killJobHard(job);
      const final = finalizeJob(handle, resolveStatus(job.backend, 0, job.log_path, false));
      return { content: [{ type: 'text', text: `killed: ${handle} (${final})` }] };
    }
    // stopped: kill process and finalize immediately
    if (job.status === 'stopped' && job.worker_pid) {
      killJobHard(job);
      const final = finalizeJob(handle, resolveStatus(job.backend, 0, job.log_path, false));
      return { content: [{ type: 'text', text: `killed: ${handle} (${final})` }] };
    }
    // running: SIGTERM then SIGKILL after delay
    if (job.worker_pid) {
      try { process.kill(-job.worker_pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-job.worker_pid, 'SIGKILL'); } catch {} }, 3_000);
    }
    // If process is already dead, finalize immediately so it can't get stuck 'running'
    if (!isProcessAlive(job.worker_pid, job.started)) {
      const final = finalizeJob(handle, resolveStatus(job.backend, 0, job.log_path, false));
      return { content: [{ type: 'text', text: `killed: ${handle} (${final})` }] };
    }
    return { content: [{ type: 'text', text: `killed: ${handle} (pid ${job.worker_pid})` }] };
  }
);

server.tool('worker_status',
  'Check status of a worker by handle.',
  { handle: z.string() },
  async ({ handle }) => {
    const job = getJob(handle);
    if (!job) throw new Error(`No job found: ${handle}`);
    let alive = false;
    if (job.worker_pid && (job.status === 'running' || job.status === 'stopped')) {
      alive = isProcessAlive(job.worker_pid, job.started);
    }
    const { backend: _b, ...safe } = job;
    return { content: [{ type: 'text', text: JSON.stringify({ ...safe, alive }) }] };
  }
);

server.tool('worker_doctor',
  'Check which backends are available.',
  { backend: z.string().optional() },
  async ({ backend }) => {
    const backends = backend ? [backend] : ['claude', 'omp', 'cmd', 'opencode', 'pool'];
    const lines = backends.map(be => {
      try {
        const ver = execSync(`${be} --version 2>/dev/null | head -1`, { encoding: 'utf8', env: workerEnv }).trim();
        return `DOCTOR|${be}|OK ${ver}`;
      } catch { return `DOCTOR|${be}|MISSING (not on PATH)`; }
    });
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

server.tool('worker_wait',
  'Wait for a background worker job to complete and return its final result. Call after worker_ladder/worker_run.',
  {
    handle: z.string().describe('Worker handle returned by worker_ladder or worker_run'),
    timeout: z.number().optional().describe('Max seconds to wait (default: no limit)'),
  },
  async ({ handle, timeout }) => {
    const waitPromise = waitJob(handle);
    let result: any;
    if (timeout) {
      const timer = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('wait timeout')), timeout * 1000));
      result = await Promise.race([waitPromise, timer]);
    } else {
      result = await waitPromise;
    }
    const { backend: _b, ...safe } = result as any;
    return { content: [{ type: 'text', text: JSON.stringify(safe) }] };
  }
);

server.tool('worker_list',
  'List recent worker jobs. Optionally filter by status.',
  {
    status: z.string().optional().describe('Filter by status: running|stopped|done|failed|timeout|killed'),
    limit: z.number().optional().describe('Max results (default 20)'),
  },
  async ({ status, limit = 20 }) => {
    const jobs = readdirSync(WORKERS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'ladder' && d.name !== 'tmux')
      .map(d => { try { return JSON.parse(readFileSync(`${WORKERS_DIR}/${d.name}/job.json`, 'utf8')); } catch { return null; } })
      .filter((j): j is NonNullable<typeof j> => j !== null)
      .filter(j => !status || j.status === status)
      .sort((a, b) => (b.started ?? '').localeCompare(a.started ?? ''))
      .slice(0, limit)
      .map(({ backend: _b, ...j }) => j);
    return { content: [{ type: 'text', text: JSON.stringify(jobs) }] };
  }
);

sweepStaleJobs();

const transport = new StdioServerTransport();
await server.connect(transport);
