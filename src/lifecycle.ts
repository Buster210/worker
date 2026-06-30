import { localISO } from "./time.ts";
import { randomUUID } from "crypto";
import { spawn, spawnSync } from "child_process";
import { readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { killProcessTree, getProcessStartTime } from "./process.ts";
import {
  handleDirUncached,
  insertJob,
  getJob,
  updateJob,
  logPath as workerLogPath,
  finalizeJob,
  reaperPidPath,
  isInPlaceOwner,
  type StashState,
} from "./state.ts";
import { addWorktreeAsync, clearStaleIndexLock } from "./worktree.ts";
import {
  buildSpec,
  buildRunArgv,
  buildResumeArgv,
  getResumeToken,
  type Backend,
} from "./backends.ts";
import { runWorker, dirtyPaths, type RunResult } from "./runner.ts";
import { loginShellEnvAsync } from "./env.ts";
import { isProcessAlive, spawnAsync } from "./process.ts";
import { buildContinuationPreamble, type SeedContext } from "./backends.ts";
import { killAndFinalizeJobs } from "./daemon.ts";

export const SERVER_STARTED =
  getProcessStartTime(process.pid) ?? localISO();
const SERVER_SID = process.env.CLAUDE_CODE_SESSION_ID ?? "";
const launchedHandles = new Set<string>();

export function trackLaunched(handle: string) {
  launchedHandles.add(handle);
}
function untrackLaunched(handle: string) {
  launchedHandles.delete(handle);
}
let _reaperPid: number | undefined;
let _reaperOwned = false;

function readReaperPid(pidPath: string): number | null {
  try {
    const parsed = Number(readFileSync(pidPath, "utf8").trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch (err) {
    // ENOENT is normal: no reaper has been spawned yet on a fresh start.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(
        "[worker] failed to read reaper pid:",
        err instanceof Error ? err.message : err,
      );
    }
    return null;
  }
}

export function spawnReaper(): void {
  try {
    if (_reaperPid && isProcessAlive(_reaperPid)) return;
    const reaperPath = new URL("./reaper.ts", import.meta.url).pathname;
    const pidPath = reaperPidPath();
    const existing = readReaperPid(pidPath);
    if (existing && isProcessAlive(existing)) {
      _reaperPid = existing;
      _reaperOwned = false;
      return;
    }
    try {
      unlinkSync(pidPath);
    } catch {}
    const child = spawn("bun", ["run", reaperPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    _reaperPid = child.pid;
    _reaperOwned = true;
    if (child.pid) {
      try {
        writeFileSync(pidPath, `${child.pid}\n`);
      } catch {}
    }
  } catch (err) {
    console.error(
      "[worker] failed to spawn reaper:",
      err instanceof Error ? err.message : err,
    );
  }
}
const _repoChecked = new Set<string>();

export function assertRepo(dir: string) {
  if (_repoChecked.has(dir)) return;
  try {
    const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      stdio: "ignore",
    });
    if (result.status !== 0) throw new Error("not a git repo");
  } catch {
    throw new Error(`Not a git repo: ${dir}`);
  }
  _repoChecked.add(dir);
}

function killByBackend(
  job: { handle: string; backend: string; worker_pid: number },
  markRequested: boolean,
): void {
  if (markRequested) updateJob(job.handle, { kill_requested: true });
  if (job.worker_pid > 0) {
    killProcessTree(job.worker_pid, "SIGKILL");
  }
}

export function forceKillJob(job: {
  handle: string;
  backend: string;
  worker_pid: number;
  log_path: string;
}): void {
  killByBackend(job, true);
}

function newHandle(backend: Backend): string {
  const id = randomUUID();
  return backend === "claude" ? id : `w-${id.slice(0, 8)}`;
}

type LaunchResult = {
  handle: string;
  promise: Promise<RunResult>;
  workdir: string;
};

function failOnError(
  handle: string,
  p: Promise<RunResult>,
): Promise<RunResult> {
  return p.catch((err: unknown) => {
    finalizeJob(handle, "failed");
    throw err;
  });
}

function gitRevParse(
  dir: string,
  ...args: string[]
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const p = spawn("git", ["rev-parse", ...args], {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
    });
    p.stdout?.on("data", (d: Buffer) => chunks.push(d));
    p.on("close", () =>
      resolve(Buffer.concat(chunks).toString().trim() || undefined),
    );
    p.on("error", () => resolve(undefined));
  });
}

function appendStashNotice(spec: string, sha?: string): string {
  if (!sha) return spec;
  return (
    spec +
    `\n\nMANDATORY FIRST STEP — before reading any other file or writing any code: the repo had uncommitted user changes at hire time, preserved in git stash commit ${sha}. Run \`git show ${sha}\` (or \`git diff ${sha}^ ${sha}\`) and state in one line which parts, if any, relate to your task. Any related part MUST be reused: apply those exact hunks (e.g. \`git checkout ${sha} -- <path>\` for whole files, or copy the hunks) — do NOT reimplement work that already exists there. Unrelated parts: ignore completely. NEVER git stash pop/drop/blind-apply the whole stash and never delete it — the server restores it after you finish.`
  );
}

export function launch(
  backend: Backend,
  prompt: string,
  dir: string,
  opts: {
    mcpSid: string;
    model?: string;
    complex?: boolean;
    extraArgs?: string[];
    timeoutMs?: number;
    deadlineAt?: number;
    completionLock?: string;
    seed?: SeedContext;
    reuseWorktree?: string;
    reuseBaseSha?: string;
    stashSha?: string;
    stashState?: StashState;
    handle?: string;
    specFile?: string;
  },
): LaunchResult {
  const handle = opts.handle ?? newHandle(backend);
  trackLaunched(handle);
  const reuse = opts.reuseWorktree;
  const lp = workerLogPath(handle, dir);
  let spec = buildSpec(prompt);

  if (opts.seed) {
    spec = buildContinuationPreamble(opts.seed) + spec;
  }

  const treePath = join(handleDirUncached(handle, dir), "tree");
  const claudeModel = opts.complex ? "sonnet" : "haiku";
  const modelToUse =
    backend === "claude" ? (opts.model ?? claudeModel) : undefined;
  insertJob({
    handle,
    backend,
    sid: opts.mcpSid,
    repo: dir,
    worktree_path: reuse ?? treePath,
    base_sha: opts.reuseBaseSha,
    stash_sha: opts.stashSha,
    stash_state: opts.stashState,
    model: modelToUse,
    task: prompt,
    log_path: lp,
    completion_lock: opts.completionLock,
    server_pid: process.pid,
    server_started: SERVER_STARTED,
    server_sid: SERVER_SID,
    deadline_at: opts.deadlineAt,
    spec_file: opts.specFile,
  });

  // The job is now 'running' on disk; spawn the orphan reaper (idempotent) so a SIGKILL of
  // this server still cleans up the worker. It self-exits once no running jobs remain, so an
  // idle server with zero workers runs no reaper.
  spawnReaper();

  let inPlace = reuse ? false : isInPlaceOwner(handle, dir);
  let wt = reuse ?? (inPlace ? dir : treePath);
  if (inPlace) updateJob(handle, { worktree_path: dir });

  const promise: Promise<RunResult> = failOnError(
    handle,
    (async () => {
      try {
        if (reuse) {
          clearStaleIndexLock(reuse);
          await loginShellEnvAsync();
          // Chain climb reuses rung 1's in-place tree with the stash still live, but
          // this rung is a fresh process — re-issue the notice so it doesn't blind
          // pop/drop the user's dirt it was never told about.
          if (opts.stashState === "stashed" && opts.stashSha)
            spec = appendStashNotice(spec, opts.stashSha);
        } else if (inPlace) {
          const dirty = await dirtyPaths(dir);
          const [, base_sha, branch] = await Promise.all([
            loginShellEnvAsync(),
            gitRevParse(dir, "HEAD"),
            (await gitRevParse(dir, "--abbrev-ref", "HEAD")) ?? "HEAD",
          ]);

          if (base_sha) updateJob(handle, { base_sha });
          updateJob(handle, { branch });
          if (dirty.length > 0) {
            const message = `worker/${handle} preexisting ${localISO()}`;
            const stash = await spawnAsync(
              "git",
              ["stash", "push", "-u", "-m", message],
              { cwd: dir, timeoutMs: 30_000 },
            );
            if (stash.error || stash.status !== 0) {
              console.error(
                `[stash] preexisting dirt stash failed for ${handle}: ${stash.error?.message ?? stash.stderr?.trim() ?? `exit ${stash.status}`}; falling back to isolated worktree`,
              );
              inPlace = false;
              wt = treePath;
              updateJob(handle, { worktree_path: wt });
              const [createdWt, , fallbackBaseSha] = await Promise.all([
                addWorktreeAsync(dir, handle),
                loginShellEnvAsync(),
                gitRevParse(dir, "HEAD"),
              ]);
              if (createdWt !== wt)
                throw new Error(`worktree path mismatch for ${handle}`);
              if (fallbackBaseSha) updateJob(handle, { base_sha: fallbackBaseSha });
              updateJob(handle, { branch: `worker/${handle}` });
            } else {
              const stashSha = await gitRevParse(dir, "refs/stash");
              if (stashSha) {
                updateJob(handle, {
                  stash_sha: stashSha,
                  stash_state: "stashed",
                });
                spec = appendStashNotice(spec, stashSha);
              }
            }
          }
        } else {
          const [createdWt, , base_sha] = await Promise.all([
            addWorktreeAsync(dir, handle),
            loginShellEnvAsync(),
            gitRevParse(dir, "HEAD"),
          ]);
          if (createdWt !== wt)
            throw new Error(`worktree path mismatch for ${handle}`);
          if (base_sha) updateJob(handle, { base_sha });
          updateJob(handle, { branch: `worker/${handle}` });
        }
      } catch (err) {
        untrackLaunched(handle);
        throw err;
      }

      const argv = buildRunArgv(
        backend,
        spec,
        wt,
        handle,
        modelToUse,
        opts.extraArgs,
      );
      const initToken =
        backend === "opencode" ? "" : getResumeToken(backend, handle, lp);
      const result = await runWorker(
        argv,
        wt,
        handle,
        backend,
        lp,
        initToken,
        opts.timeoutMs,
        opts.deadlineAt,
      );
      if (backend === "opencode") {
        const tok = getResumeToken("opencode", handle, lp);
        if (tok) {
          result.resume_token = tok;
          updateJob(handle, { resume_token: tok });
        }
      }
      return result;
    })(),
  ).finally(() => untrackLaunched(handle));

  return { handle, promise, workdir: wt };
}
export async function shutdown(): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;

  if (_reaperOwned && _reaperPid) {
    try {
      process.kill(_reaperPid, "SIGTERM");
    } catch (err) {
      console.error(
        "[worker] failed to kill reaper:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  const jobs: NonNullable<ReturnType<typeof getJob>>[] = [];
  for (const handle of launchedHandles) {
    const job = getJob(handle);
    if (!job || (job.status !== "running" && job.status !== "stopped"))
      continue;
    jobs.push(job);
  }
  launchedHandles.clear();

  killAndFinalizeJobs(jobs, "failed");
  process.exit(0);
}
let _shuttingDown = false;
export function resetShutdownState(): void {
  _shuttingDown = false;
  launchedHandles.clear();
  _reaperPid = undefined;
  _reaperOwned = false;
}

export function resumeLaunch(args: {
  handle: string;
  prompt: string;
  dir: string;
  timeout?: number;
  extraArgs?: string[];
  specFile?: string;
}): { handle: string; promise: Promise<RunResult>; workdir: string } {
  const { handle, prompt, dir, timeout, extraArgs, specFile } = args;
  const job = getJob(handle);
  if (!job) throw new Error(`No job found for handle: ${handle}`);
  updateJob(handle, { kill_requested: false });

  const wtDir = job.worktree_path ?? dir;

  const be = job.backend as Backend;
  const lp = workerLogPath(handle);
  let spec = buildSpec(prompt);
  if (job.stash_state === "stashed" && job.stash_sha) {
    spec = appendStashNotice(spec, job.stash_sha);
  }
  if (be === "cmd") {
    spec =
      `A prior attempt already ran in this repo — inspect the working tree, determine what is already done, and complete only the remainder.\n\n` +
      spec;
  }
  const argv = buildResumeArgv(
    be,
    spec,
    wtDir,
    job.resume_token,
    job.model,
    extraArgs,
  );
  if (specFile) updateJob(handle, { spec_file: specFile });
  const p = runWorker(
    argv,
    wtDir,
    handle,
    be,
    lp,
    job.resume_token,
    timeout ? timeout * 1000 : undefined,
  );
  return { handle, promise: failOnError(handle, p), workdir: wtDir };
}
