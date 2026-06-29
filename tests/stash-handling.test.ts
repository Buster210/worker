import {
  describe,
  it,
  expect,
  afterAll,
  afterEach,
  beforeAll,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";

const STATE_DIR = join(tmpdir(), `wstash-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;

const BIN_DIR = mkdtempSync(join(tmpdir(), `wstash-bin-${process.pid}-`));
const PREV_PATH = process.env.PATH ?? "";
const WORKER_ENV = workerEnv();
const PREV_WORKER_PATH = WORKER_ENV.PATH ?? "";

beforeAll(() => {
  process.env.PATH = `${BIN_DIR}:${PREV_PATH}`;
  WORKER_ENV.PATH = `${BIN_DIR}:${PREV_WORKER_PATH}`;
  const cmdPath = join(BIN_DIR, "cmd");
  const cmdScript = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'repo=""',
    "for ((i=1; i<=$#; i++)); do",
    '  arg="${!i}"',
    '  if [[ "$arg" == "--add-dir" ]]; then',
    "    j=$((i+1))",
    '    repo="${!j}"',
    "    break",
    "  fi",
    "done",
    'if [[ -n "${WORKER_FAKE_ARGS_FILE:-}" ]]; then printf "%s\\n" "$@" > "$WORKER_FAKE_ARGS_FILE"; fi',
    'sleep_for="${WORKER_FAKE_DELAY_SEC:-0}"',
    'if [[ "$sleep_for" != "0" ]]; then sleep "$sleep_for"; fi',
    'mode="${WORKER_FAKE_MODE:-write-done}"',
    'file="${WORKER_FAKE_FILE:-worker.txt}"',
    'content="${WORKER_FAKE_CONTENT:-worker}"',
    'case "$mode" in',
    "  write-done|dirty-done|resume-done)",
    '    printf "%s\\n" "$content" > "$repo/$file"',
    "    echo DONE",
    "    exit 0",
    "    ;;",
    "  write-fail|resume-fail)",
    '    printf "%s\\n" "$content" > "$repo/$file"',
    "    echo FAILED",
    "    exit 1",
    "    ;;",
    "  *)",
    "    echo FAILED",
    "    exit 1",
    "    ;;",
    "esac",
  ].join("\n");
  writeFileSync(
    cmdPath,
    cmdScript,
    { mode: 0o755 },
  );
});

afterAll(() => {
  process.env.PATH = PREV_PATH;
  WORKER_ENV.PATH = PREV_WORKER_PATH;
  try {
    rmSync(BIN_DIR, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(STATE_DIR, { recursive: true, force: true });
  } catch {}
});

import { launch, resumeLaunch } from "../src/lifecycle.ts";
import {
  getJob,
  getJobFresh,
  insertJob,
  restoreJobStash,
  __resetStateForTest,
  logPath as stateLogPath,
} from "../src/state.ts";
import { renderReport } from "../src/report.ts";
import { handleList, handleStatus } from "../src/server.ts";
import { workerEnv } from "../src/env.ts";

const repos: string[] = [];

function initRepo(name: string): string {
  const repo = mkdtempSync(join(tmpdir(), name));
  repos.push(repo);
  spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "config", "user.email", "test@test.com"], {
    encoding: "utf8",
  });
  spawnSync("git", ["-C", repo, "config", "user.name", "Test"], {
    encoding: "utf8",
  });
  writeFileSync(join(repo, "README.md"), "init\n");
  spawnSync("git", ["-C", repo, "add", "."], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "commit", "-m", "init", "--no-gpg-sign"], {
    encoding: "utf8",
  });
  return repo;
}

function git(repo: string, ...args: string[]): string {
  return spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
  }).stdout.trim();
}

function gitExec(repo: string, ...args: string[]) {
  return spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
  });
}

function setFakeWorker(env: Record<string, string>): void {
  delete process.env.WORKER_FAKE_DELAY_SEC;
  delete process.env.WORKER_FAKE_MODE;
  delete process.env.WORKER_FAKE_FILE;
  delete process.env.WORKER_FAKE_CONTENT;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

function killWorker(handle: string): void {
  const pid = getJob(handle)?.worker_pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

afterEach(() => {
  __resetStateForTest();
  try {
    rmSync(STATE_DIR, { recursive: true, force: true });
  } catch {}
  mkdirSync(STATE_DIR, { recursive: true });
  for (const repo of repos.splice(0)) {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {}
  }
  delete process.env.WORKER_FAKE_DELAY_SEC;
  delete process.env.WORKER_FAKE_MODE;
  delete process.env.WORKER_FAKE_FILE;
  delete process.env.WORKER_FAKE_CONTENT;
});

describe("stash-based in-place launches", () => {
  it("stashes dirty in-place trees and records the stash sha", async () => {
    const repo = initRepo(`wstash-dirty-${process.pid}-`);
    writeFileSync(join(repo, "user.txt"), "user\n");
    setFakeWorker({
      WORKER_FAKE_MODE: "dirty-done",
      WORKER_FAKE_DELAY_SEC: "0.5",
      WORKER_FAKE_FILE: "worker.txt",
      WORKER_FAKE_CONTENT: "worker\n",
    });

    const { handle, promise, workdir } = launch("cmd", "task", repo, {
      mcpSid: "sid",
      handle: `stash-${process.pid}-dirty`,
    });
    expect(workdir).toBe(repo);

    // Poll instead of a fixed sleep: the stash push runs after loginShellEnvAsync,
    // whose login-shell spawn latency varies — a fixed 100ms races it.
    let job = getJob(handle)!;
    for (let i = 0; i < 250 && job?.stash_state !== "stashed"; i++) {
      await Bun.sleep(20);
      job = getJob(handle)!;
    }
    expect(job.stash_state).toBe("stashed");
    expect(job.stash_sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(git(repo, "status", "--porcelain")).toBe("");
    killWorker(handle);
    void promise.catch(() => {});
  });

  it("skips stashing on a clean launch", async () => {
    const repo = initRepo(`wstash-clean-${process.pid}-`);
    setFakeWorker({
      WORKER_FAKE_MODE: "write-done",
      WORKER_FAKE_FILE: "worker.txt",
      WORKER_FAKE_CONTENT: "worker\n",
    });

    const { handle, promise } = launch("cmd", "task", repo, {
      mcpSid: "sid",
      handle: `stash-${process.pid}-clean`,
    });

    await Bun.sleep(50);
    const job = getJob(handle)!;
    expect(job.stash_sha).toBeUndefined();
    expect(job.stash_state).toBeUndefined();
    killWorker(handle);
    void promise.catch(() => {});
  });

  it("re-issues the stash notice to a reused rung (chain climb)", async () => {
    const repo = initRepo(`wstash-reuse-${process.pid}-`);
    const argsFile = join(STATE_DIR, `reuse-argv-${process.pid}.txt`);
    const stashSha = "0123456789abcdef0123456789abcdef01234567";
    // The worker inherits the cached workerEnv() object, NOT process.env, so the
    // fake-backend knobs go there — the same channel the PATH shim uses. WORKER_RC
    // is cleared so the spawn wrapper skips sourcing the real login rc, which hangs
    // a worker we observe synchronously (other tests never read worker output).
    const prevRc = WORKER_ENV.WORKER_RC;
    WORKER_ENV.WORKER_RC = "";
    WORKER_ENV.WORKER_FAKE_MODE = "write-fail";
    WORKER_ENV.WORKER_FAKE_ARGS_FILE = argsFile;
    try {
      const { handle, promise } = launch("cmd", "task", repo, {
        mcpSid: "sid",
        handle: `stash-${process.pid}-reuse`,
        reuseWorktree: repo,
        reuseBaseSha: git(repo, "rev-parse", "HEAD"),
        stashSha,
        stashState: "stashed",
      });

      // Worker spawn goes through loginShellEnvAsync (login-shell latency), so poll
      // generously; the test timeout below outlasts the poll budget.
      let argv = "";
      for (let i = 0; i < 500 && !argv; i++) {
        await Bun.sleep(20);
        try {
          argv = readFileSync(argsFile, "utf8");
        } catch {}
      }
      // The fresh rung's prompt must carry the stash notice (which cites the sha),
      // else it has no idea a stash exists and may blind pop/drop the user's dirt.
      expect(argv).toContain(stashSha);
      killWorker(handle);
      void promise.catch(() => {});
    } finally {
      WORKER_ENV.WORKER_RC = prevRc;
      delete WORKER_ENV.WORKER_FAKE_MODE;
      delete WORKER_ENV.WORKER_FAKE_ARGS_FILE;
    }
  }, 20_000);

  it("restores a clean apply, drops the stash, and marks restored", async () => {
    const repo = initRepo(`wstash-restore-${process.pid}-`);
    writeFileSync(join(repo, "user.txt"), "base\n");
    gitExec(repo, "add", ".");
    gitExec(repo, "commit", "-m", "base", "--no-gpg-sign");
    writeFileSync(join(repo, "user.txt"), "user\n");
    gitExec(repo, "stash", "push", "-u", "-m", `worker/stash-restore-${process.pid} preexisting`);
    const stashSha = git(repo, "rev-parse", "refs/stash");
    writeFileSync(join(repo, "worker.txt"), "worker\n");
    gitExec(repo, "add", ".");
    gitExec(repo, "commit", "-m", "worker", "--no-gpg-sign");
    const handle = `stash-${process.pid}-restore`;
    insertJob({
      handle,
      backend: "cmd",
      sid: "sid",
      repo,
      log_path: stateLogPath(handle, repo),
      worktree_path: repo,
      stash_sha: stashSha,
      stash_state: "stashed",
    });
    expect(await restoreJobStash(handle)).toBe("restored");

    const job = getJobFresh(handle)!;
    expect(job.stash_state).toBe("restored");
    expect(git(repo, "stash", "list", "--oneline")).toBe("");
    expect(git(repo, "show", "--pretty=format:", "--name-only", "HEAD")).toContain("worker.txt");
    expect(git(repo, "status", "--porcelain")).toContain("user.txt");
  });

  it("drops only the worker's entry, preserving the user's own stash beneath it", async () => {
    const repo = initRepo(`wstash-sibling-${process.pid}-`);
    writeFileSync(join(repo, "user.txt"), "base\n");
    gitExec(repo, "add", ".");
    gitExec(repo, "commit", "-m", "base", "--no-gpg-sign");
    writeFileSync(join(repo, "user.txt"), "user-own\n");
    gitExec(repo, "stash", "push", "-m", "user own stash");
    const userStashSha = git(repo, "rev-parse", "refs/stash");
    writeFileSync(join(repo, "other.txt"), "dirt\n");
    gitExec(repo, "stash", "push", "-u", "-m", `worker/sibling-${process.pid} preexisting`);
    const stashSha = git(repo, "rev-parse", "refs/stash");
    writeFileSync(join(repo, "worker.txt"), "worker\n");
    gitExec(repo, "add", ".");
    gitExec(repo, "commit", "-m", "worker", "--no-gpg-sign");
    const handle = `stash-${process.pid}-sibling`;
    insertJob({
      handle,
      backend: "cmd",
      sid: "sid",
      repo,
      log_path: stateLogPath(handle, repo),
      worktree_path: repo,
      stash_sha: stashSha,
      stash_state: "stashed",
    });
    expect(await restoreJobStash(handle)).toBe("restored");

    expect(git(repo, "stash", "list", "--format=%H").split("\n")).toEqual([
      userStashSha,
    ]);
    expect(git(repo, "stash", "list", "--format=%s")).toContain("user own stash");
  });

  it("keeps the stash on conflict and preserves the committed worker edit", async () => {
    const repo = initRepo(`wstash-conflict-${process.pid}-`);
    writeFileSync(join(repo, "shared.txt"), "base\n");
    gitExec(repo, "add", ".");
    gitExec(repo, "commit", "-m", "base", "--no-gpg-sign");
    writeFileSync(join(repo, "shared.txt"), "user\n");
    gitExec(repo, "stash", "push", "-u", "-m", `worker/stash-conflict-${process.pid} preexisting`);
    const stashSha = git(repo, "rev-parse", "refs/stash");
    writeFileSync(join(repo, "shared.txt"), "worker\n");
    gitExec(repo, "add", ".");
    gitExec(repo, "commit", "-m", "worker", "--no-gpg-sign");
    const handle = `stash-${process.pid}-conflict`;
    insertJob({
      handle,
      backend: "cmd",
      sid: "sid",
      repo,
      log_path: stateLogPath(handle, repo),
      worktree_path: repo,
      stash_sha: stashSha,
      stash_state: "stashed",
    });
    expect(await restoreJobStash(handle)).toBe("conflict");

    const job = getJobFresh(handle)!;
    expect(job.stash_state).toBe("conflict");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "show", "--pretty=format:", "--name-only", "HEAD")).toContain("shared.txt");
    expect(git(repo, "show", "HEAD:shared.txt")).toContain("worker");
    expect(git(repo, "stash", "list", "--format=%s")).toContain(
      `worker/stash-conflict-${process.pid} preexisting`,
    );
  });
});

describe("resume and surfaces", () => {
  it("preserves stash fields across resumeLaunch", async () => {
    const repo = initRepo(`wstash-resume-${process.pid}-`);
    const handle = `stash-${process.pid}-resume`;
    const lp = stateLogPath(handle, repo);
    insertJob({
      handle,
      backend: "cmd",
      sid: "sid",
      repo,
      log_path: lp,
      worktree_path: repo,
      resume_token: "tok",
      stash_sha: "abc123def456",
      stash_state: "stashed",
    });
    setFakeWorker({
      WORKER_FAKE_MODE: "resume-fail",
      WORKER_FAKE_DELAY_SEC: "0.5",
      WORKER_FAKE_FILE: "resume.txt",
      WORKER_FAKE_CONTENT: "resume\n",
    });

    const { promise } = resumeLaunch({
      handle,
      prompt: "task",
      dir: repo,
    });

    const job = getJob(handle)!;
    expect(job.stash_sha).toBe("abc123def456");
    expect(job.stash_state).toBe("stashed");
    killWorker(handle);
    void promise.catch(() => {});
  });

  it("surfaces outstanding stash state in report, status, and list output", () => {
    const repo = initRepo(`wstash-surface-${process.pid}-`);
    const handle = `stash-${process.pid}-surface`;
    insertJob({
      handle,
      backend: "cmd",
      sid: "sid",
      repo,
      log_path: stateLogPath(handle, repo),
      stash_sha: "abc123def456",
      stash_state: "stashed",
    });

    expect(renderReport(handle, `/any/${handle}/.lock`, () => "DIFF")).toContain(
      "stash abc123def456 preserved — restore: git stash apply abc123def456",
    );
    expect(handleStatus({ handle }).stash).toBe(
      "stash abc123def456 preserved — restore: git stash apply abc123def456",
    );
    expect(
      handleList({}).find((row) => row.handle === handle)?.stash,
    ).toBe(
      "stash abc123def456 preserved — restore: git stash apply abc123def456",
    );
  });
});
