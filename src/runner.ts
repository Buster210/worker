import { spawn } from "child_process";
import {
  openSync,
  closeSync,
  writeSync,
  statSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
} from "fs";
import { join, dirname } from "path";
import {
  updateJob,
  getJob,
  finalizeJob,
  archiveSpec,
  workersDir,
  restoreJobStash,
} from "./state.ts";
import { emitsJsonLog, QUIET_BACKENDS, type Backend } from "./backends.ts";
import { readSentinel } from "./logParse.ts";
import { killProcessTree, spawnAsync } from "./process.ts";
import { FILE_CONFIG } from "./config.ts";

import {
  defaultTimeoutMs,
  workerEnv,
  watchdogMs,
  stallTimeoutMs,
  quietStallMs,
  graceMs,
  cpuThrottleArgv,
} from "./env.ts";

export type RunResult = {
  status: string;
  exit_code: number;
  backend: string;
  handle: string;
  resume_token: string;
  repo: string;
  log: string;
};
function markStallOutcome(
  handle: string,
  pid: number,
  logPath: string,
  backend: string,
): boolean {
  killProcessTree(pid, "SIGKILL");
  const { status } = readSentinel(logPath, emitsJsonLog(backend));
  if (status !== null && status.startsWith("failed")) {
    return false;
  }
  finalizeJob(handle, "stalled");
  return true;
}

export function backendShellArgv(argv: string[]): string[] {
  const shell = process.env.SHELL ?? "/bin/zsh";
  return [
    ...cpuThrottleArgv(),
    shell,
    "-c",
    '[ -n "$WORKER_RC" ] && [ -f "$WORKER_RC" ] && . "$WORKER_RC"; "$0" "$@"',
    ...argv,
  ];
}

function launchAndWait(
  argv: string[],
  repo: string,
  handle: string,
  backend: Backend,
  logPath: string,
  timeoutMs?: number,
  deadlineAt?: number,
): Promise<{ rc: number; timedOut: boolean; stalled: boolean }> {
  return new Promise((resolve) => {
    const logFd = openSync(logPath, "a");
    const [cmd, ...args] = backendShellArgv(argv);
    const proc = spawn(cmd, args, {
      cwd: repo,
      env: workerEnv(),
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    const startMs = Date.now();
    const deadline = deadlineAt ?? startMs + (timeoutMs ?? defaultTimeoutMs());

    if (proc.pid) {
      try {
        updateJob(handle, { worker_pid: proc.pid, deadline_at: deadline });
      } catch (err) {
        console.error(
          "[worker] failed to update job with PID:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    let rc = 0;
    let stalled = false;
    let settled = false;
    let exiting = false;
    const mon = startActivityMonitor(repo, logPath);
    let lastSig = mon.sig;
    let lastActivityAt = mon.at;

    const finish = (code: number, timed: boolean, stalledJob: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      try {
        mon.dispose();
      } catch {}
      try {
        closeSync(logFd);
      } catch {}
      resolve({ rc: code, timedOut: timed, stalled: stalledJob });
    };

    const killOnStallAndFinish = () => {
      if (settled || exiting) return;
      exiting = true;
      stalled = markStallOutcome(handle, proc.pid!, logPath, backend);
      finish(124, false, stalled);
    };

    const killAtGrace = () => {
      if (settled || exiting) return;
      exiting = true;
      killProcessTree(proc.pid!, "SIGKILL");
      finish(124, true, false);
    };

    const watchdog = setInterval(() => {
      if (settled || exiting) return;
      const now = Date.now();
      const deadline = getJob(handle)?.deadline_at;
      if (deadline && now >= deadline + graceMs()) {
        killAtGrace();
        return;
      }

      if (mon.sig !== lastSig) {
        lastSig = mon.sig;
        lastActivityAt = mon.at;
      } else if (
        now - lastActivityAt >=
        (QUIET_BACKENDS.has(backend) ? quietStallMs() : stallTimeoutMs())
      ) {
        killOnStallAndFinish();
        return;
      }
    }, watchdogMs());
    watchdog.unref?.();

    proc.on("exit", (code, signal) => {
      exiting = true;
      rc = code ?? (signal ? 1 : 0);
      finish(rc, false, false);
    });

    proc.on("error", (err) => {
      const msg = `spawn error: ${err.message}`;
      console.error("[worker] backend spawn failed:", msg);
      try {
        writeSync(logFd, `\n${msg}\n`);
      } catch {}
      finish(1, false, false);
    });
  });
}

export async function runWorker(
  argv: string[],
  repo: string,
  handle: string,
  backend: Backend,
  logPath: string,
  resumeToken: string,
  timeoutMs?: number,
  deadlineAt?: number,
): Promise<RunResult> {
  const job = getJob(handle);
  const { rc, timedOut, stalled } = await launchAndWait(
    argv,
    repo,
    handle,
    backend,
    logPath,
    timeoutMs,
    deadlineAt,
  );
  let status: string;
  if (stalled) {
    status = "stalled";
  } else {
    const natural = resolveStatus(backend, rc, logPath, timedOut);
    const gated = await maybeVerifyAndCommit(handle, repo, natural, job?.base_sha);
    status = finalizeJob(handle, gated, { resume_token: resumeToken });
    // Defer to the chain's own restore only while the chain still drives
    // (lock file present) — a resumed job from a finished chain restores here.
    const cl = job?.completion_lock ?? "";
    if (status === "done" && !(cl.endsWith(".chain.lock") && existsSync(cl))) {
      archiveSpec(handle);
      await restoreJobStash(handle);
    }
  }
  console.error(`[worker] done: ${backend} ${handle.slice(0, 8)} → ${status}`);
  return {
    status,
    exit_code: rc,
    backend,
    handle,
    resume_token: resumeToken,
    repo,
    log: logPath,
  };
}

export function resolveStatus(
  backend: string,
  rc: number,
  logPath: string,
  timedOut: boolean,
): string {
  if (timedOut) return "timeout";
  const { status } = readSentinel(logPath, emitsJsonLog(backend));
  if (status) return status;
  if (backend === "cmd")
    return rc === 0 ? "done" : rc === 8 ? "failed:max-turns" : "failed";
  if (backend === "pool")
    return rc === 0 ? "done" : rc === 4 ? "failed:task" : "failed";
  return rc === 0 ? "done" : "failed";
}

type ActivityMonitor = {
  readonly sig: string;
  readonly log: string;
  readonly at: number;
  readonly repo: string;
  readonly logPath: string;
  dispose: () => void;
};

const _activityMonitors = new Map<string, ActivityMonitor>();

function readLogStat(logPath: string): string {
  try {
    const st = statSync(logPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

export function startActivityMonitor(
  repo: string,
  logPath: string,
): ActivityMonitor {
  const key = `${repo}\0${logPath}`;
  let cachedLog = readLogStat(logPath);
  let cachedAt = Date.now();
  let lastPollAt = 0;
  const poll = () => {
    if (Date.now() === lastPollAt) return;
    lastPollAt = Date.now();
    const fresh = readLogStat(logPath);
    if (fresh && fresh !== cachedLog) {
      cachedLog = fresh;
      cachedAt = Date.now();
    }
  };
  const mon: ActivityMonitor = {
    get sig() {
      poll();
      return cachedLog;
    },
    get log() {
      return cachedLog;
    },
    get at() {
      poll();
      return cachedAt;
    },
    repo,
    logPath,
    dispose() {
      _activityMonitors.delete(key);
    },
  };
  _activityMonitors.set(key, mon);
  return mon;
}

export function __resetActivityMonitors(): void {
  for (const m of _activityMonitors.values()) {
    try {
      m.dispose();
    } catch {}
  }
  _activityMonitors.clear();
}

function commitMessage(handle: string): string {
  const task = getJob(handle)?.task ?? "";
  const firstLine = task.split("\n")[0].trim();
  return firstLine
    ? `worker: ${firstLine}`.slice(0, 72)
    : "worker: automated change";
}

type GpgMode = "loopback" | "agent" | "cache";

export function resolveGpgMode(): GpgMode {
  const raw = (
    process.env.WORKER_GPG_MODE ??
    FILE_CONFIG.gpgMode ??
    "loopback"
  ).toLowerCase();
  return raw === "agent" || raw === "cache" ? raw : "loopback";
}

export function loopbackWrapperBody(): string {
  return `#!/bin/sh
exec gpg --pinentry-mode loopback --passphrase-fd 3 --batch --no-tty "$@" 3<<GPGPW
$WORKER_GPG_PASSPHRASE
GPGPW
`;
}

function ensureLoopbackWrapper(): string {
  const path = join(workersDir(), "gpg-loopback-sign.sh");
  const body = loopbackWrapperBody();
  try {
    mkdirSync(dirname(path), { recursive: true });
    let current: string | null = null;
    try {
      current = readFileSync(path, "utf8");
    } catch {}
    if (current !== body) writeFileSync(path, body, { mode: 0o700 });
    chmodSync(path, 0o700);
  } catch (e) {
    console.error(
      `[commit] failed to write gpg loopback wrapper: ${(e as Error).message}`,
    );
  }
  return path;
}

async function presetBinPath(): Promise<string | null> {
  const r = await spawnAsync("gpgconf", ["--list-dirs", "libexecdir"], {
    timeoutMs: 10_000,
  });
  if (r.status !== 0 || !r.stdout) return null;
  const path = join(r.stdout.trim(), "gpg-preset-passphrase");
  return existsSync(path) ? path : null;
}

// ponytail: a distinct signing subkey would need its own grp line; set WORKER_GPG_KEYGRIP for that.
async function discoverPrimaryKeygrip(worktree: string): Promise<string | null> {
  const idRes = await spawnAsync(
    "git",
    ["-C", worktree, "config", "--get", "user.signingkey"],
    { timeoutMs: 10_000 },
  );
  const keyId = idRes.status === 0 ? idRes.stdout.trim() : "";
  const args = [
    "--batch",
    "--with-colons",
    "--with-keygrip",
    "--list-secret-keys",
  ];
  if (keyId) args.push(keyId);
  const r = await spawnAsync("gpg", args, { timeoutMs: 10_000 });
  if (r.status !== 0 || !r.stdout) return null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("grp:")) return line.split(":")[9] || null;
  }
  return null;
}

async function presetAgentPassphrase(worktree: string): Promise<string | null> {
  const passphrase = process.env.WORKER_GPG_PASSPHRASE;
  if (!passphrase) return "WORKER_GPG_PASSPHRASE not set";
  const keygrip =
    process.env.WORKER_GPG_KEYGRIP ??
    FILE_CONFIG.gpgKeygrip ??
    (await discoverPrimaryKeygrip(worktree));
  if (!keygrip) return "could not resolve keygrip (set WORKER_GPG_KEYGRIP)";
  const preset = await presetBinPath();
  if (!preset) return "gpg-preset-passphrase not found (is gnupg installed?)";
  const r = await spawnAsync(preset, ["--preset", keygrip], {
    input: passphrase,
    timeoutMs: 15_000,
  });
  if (r.error) return r.error.message;
  if (r.status !== 0)
    return (
      r.stderr?.trim() ||
      `gpg-preset-passphrase exit ${r.status} (need allow-preset-passphrase in gpg-agent.conf)`
    );
  return null;
}

export async function dirtyPaths(worktree: string): Promise<string[]> {
  const r = await spawnAsync(
    "git",
    ["-C", worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { timeoutMs: 30_000 },
  );
  if (r.status !== 0 || !r.stdout) return [];
  const parts = r.stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    paths.push(path);
    // Rename entries carry the original path as the next NUL token — skip it.
    if (status[0] === "R" || status[1] === "R") i++;
  }
  return paths;
}

async function stageWorktree(
  worktree: string,
  handle: string,
): Promise<"ok" | "failed:commit"> {
  const addArgs = ["-C", worktree, "add", "-A"];

  const add = await spawnAsync("git", addArgs, { timeoutMs: 30_000 });
  if (add.error) {
    console.error(
      `[commit] git add failed for ${handle}: ${add.error.message}`,
    );
    return "failed:commit";
  }
  if (add.status !== 0) {
    console.error(
      `[commit] git add failed for ${handle}: ${add.stderr?.trim() ?? ""}`,
    );
    return "failed:commit";
  }
  await spawnAsync("git", ["-C", worktree, "reset", "-q", "--", ".codegraph"], {
    timeoutMs: 30_000,
  });
  return "ok";
}

async function hasStagedChanges(
  worktree: string,
): Promise<"yes" | "no" | "failed:commit"> {
  const diff = await spawnAsync(
    "git",
    ["-C", worktree, "diff", "--cached", "--quiet"],
    { timeoutMs: 30_000 },
  );
  if (diff.error) {
    console.error(
      `[commit] git diff --cached --quiet failed: ${diff.error.message}`,
    );
    return "failed:commit";
  }
  return diff.status === 0 ? "no" : "yes";
}

async function headMovedSince(
  worktree: string,
  baseSha: string | undefined,
): Promise<boolean> {
  if (!baseSha) return false;
  const head = await spawnAsync("git", ["-C", worktree, "rev-parse", "HEAD"], {
    timeoutMs: 30_000,
  });
  return head.status === 0 && head.stdout?.trim() !== baseSha;
}

async function commitWork(
  worktree: string,
  handle: string,
  baseSha: string | undefined,
): Promise<"done" | "failed:commit" | "failed:no-changes"> {
  const staged = await stageWorktree(worktree, handle);
  if (staged !== "ok") return staged;
  const stagedChanges = await hasStagedChanges(worktree);
  if (stagedChanges === "failed:commit") return "failed:commit";
  if (stagedChanges === "no") {
    // Backend may have committed its own work mid-turn (e.g. cmd/Command
    // Code auto-commits) — nothing left to stage isn't the same as no work done.
    if (await headMovedSince(worktree, baseSha)) return "done";
    return "failed:no-changes";
  }

  const mode = resolveGpgMode();
  const args = ["-C", worktree];
  if (mode === "loopback") {
    args.push("-c", `gpg.program=${ensureLoopbackWrapper()}`);
  } else if (mode === "agent") {
    const err = await presetAgentPassphrase(worktree);
    if (err) {
      console.error(`[commit] gpg agent preset failed for ${handle}: ${err}`);
      return "failed:commit";
    }
  }
  args.push("commit", "-m", commitMessage(handle));

  const commit = await spawnAsync("git", args, { timeoutMs: 60_000 });
  if (commit.error) {
    console.error(
      `[commit] git commit failed for ${handle}: ${commit.error.message}`,
    );
    return "failed:commit";
  }
  if (commit.status !== 0) {
    const hasPass = process.env.WORKER_GPG_PASSPHRASE ? "set" : "unset";
    console.error(
      `[commit] git commit failed for ${handle} (gpg mode=${mode}, passphrase=${hasPass}): ${commit.stderr?.trim() ?? ""}`,
    );
    return "failed:commit";
  }
  return "done";
}

export async function maybeVerifyAndCommit(
  handle: string,
  worktree: string,
  natural: string,
  baseSha?: string,
): Promise<string> {
  if (natural !== "done") return natural;

  const cmd = process.env.WORKER_VERIFY_CMD ?? FILE_CONFIG.verifyCmd;
  if (cmd && cmd.length > 0) {
    const shell = process.env.SHELL ?? "/bin/zsh";
    const result = await spawnAsync(shell, ["-c", cmd], {
      cwd: worktree,
      timeoutMs: 120_000,
      discardOutput: true,
    });
    if (result.status !== 0 || result.error) {
      console.error(
        `[commit] verify gate failed for ${handle}: exit ${result.status ?? "error"}`,
      );
      return "failed:verify";
    }
  }

  return commitWork(worktree, handle, baseSha);
}
