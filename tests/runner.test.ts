import { describe, it, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { spawn, spawnSync } from "child_process";
import { writeFileSync, rmSync, mkdtempSync, openSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const STATE_DIR = join(tmpdir(), `wrunner-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;

process.env.WORKER_RC = "";

import { runWorker } from "../src/runner.ts";
import { reapStoppedJobs } from "../src/maintenance.ts";
import { isProcessAlive, parseEtimeSeconds } from "../src/process.ts";
import {
  insertJob,
  getJob,
  updateJob,
  logPath as stateLogPath,
} from "../src/state.ts";

const REPO = mkdtempSync(join(tmpdir(), "wrunner-repo-"));
spawnSync("git", ["-C", REPO, "init", "-q"], { encoding: "utf8" });
spawnSync("git", ["-C", REPO, "config", "user.email", "test@test.com"], {
  encoding: "utf8",
});
spawnSync("git", ["-C", REPO, "config", "user.name", "Test"], {
  encoding: "utf8",
});
writeFileSync(join(REPO, "README.md"), "init\n");
spawnSync("git", ["-C", REPO, "add", "."], { encoding: "utf8" });
spawnSync("git", ["-C", REPO, "commit", "-m", "init", "--no-gpg-sign"], {
  encoding: "utf8",
});
const tmpFiles: string[] = [];
const frozenPids: number[] = [];
const tmpDirs: string[] = [];
let seq = 0;

function fakeScript(body: string): string[] {
  const path = join(tmpdir(), `wfake-${process.pid}-${seq++}.sh`);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  tmpFiles.push(path);
  return ["bash", path];
}

function seedJob(handle: string): string {
  const lp = stateLogPath(handle, REPO);
  insertJob({ handle, backend: "cmd", sid: "test", repo: REPO, log_path: lp });
  return lp;
}

function spawnDetached(body: string, lp: string): number {
  const [cmd, path] = fakeScript(body);
  const fd = openSync(lp, "a");
  const proc = spawn(cmd, [path], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  proc.unref();
  return proc.pid!;
}

afterEach(() => {
  for (const k of [
    "WORKER_POLL_MS",
    "WORKER_WATCHDOG_MS",
    "WORKER_RESUME_POLL_MS",
    "WORKER_STALL_MS",
    "WORKER_STALL_MS_QUIET",
    "WORKER_TIMEOUT_MS",
    "WORKER_REAP_MS",
    "WORKER_GRACE_MS",
    "WORKER_REAPER_MS",
  ]) {
    delete process.env[k];
  }
});

afterAll(() => {
  for (const pid of frozenPids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  for (const f of tmpFiles) {
    try {
      rmSync(f, { force: true });
    } catch {}
  }
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  try {
    rmSync(REPO, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(STATE_DIR, { recursive: true, force: true });
  } catch {}
});

describe("runWorker lifecycle (real subprocess)", () => {
  it('resolves "done" when the worker prints DONE and exits 0', async () => {
    const handle = `done-${seq}`;
    const lp = seedJob(handle);
    const r = await runWorker(
      fakeScript(`echo work > ${handle}.out; echo; echo DONE`),
      REPO,
      handle,
      "cmd",
      lp,
      "",
    );
    expect(r.status).toBe("done");
    expect(getJob(handle)?.status).toBe("done");
  });

  it('resolves "failed" when the worker prints FAILED and exits nonzero', async () => {
    const handle = `failed-${seq}`;
    const lp = seedJob(handle);
    const r = await runWorker(
      fakeScript("echo; echo FAILED\nexit 1"),
      REPO,
      handle,
      "cmd",
      lp,
      "",
    );
    expect(r.status).toBe("failed");
  });

  it('resolves "failed:<reason>" when the worker prints FAILED: reason', async () => {
    const handle = `failedreason-${seq}`;
    const lp = seedJob(handle);
    const r = await runWorker(
      fakeScript('echo; echo "FAILED: boom"\nexit 1'),
      REPO,
      handle,
      "cmd",
      lp,
      "",
    );
    expect(r.status).toBe("failed:boom");
  });

  it("does NOT stall a codex worker within the normal stall window (uses quiet threshold)", async () => {
    const handle = `codex-no-stall-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_WATCHDOG_MS = "50";
    process.env.WORKER_STALL_MS = "200";
    process.env.WORKER_STALL_MS_QUIET = "5000";

    const r = await runWorker(
      fakeScript(`echo work > ${handle}.out; sleep 0.4; echo; echo DONE`),
      REPO,
      handle,
      "codex",
      lp,
      "",
      60_000,
    );
    expect(r.status).toBe("done");
    expect(r.exit_code).toBe(0);
  });

  it('kills a quiet idle worker to "stalled" when it stalls (SIGKILL, not frozen)', async () => {
    const handle = `stall-quiet-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_WATCHDOG_MS = "50";
    process.env.WORKER_STALL_MS = "200";

    const started = Date.now();
    const r = await runWorker(
      fakeScript("sleep 20"),
      REPO,
      handle,
      "cmd",
      lp,
      "",
      60_000,
    );
    const elapsed = Date.now() - started;
    expect(r.status).toBe("stalled");
    expect(elapsed).toBeLessThan(1500);
    const job = getJob(handle);
    expect(job?.status).toBe("stalled");
    expect(job?.finished).toBeTruthy();
    const pid = job?.worker_pid;
    if (pid) {
      await Bun.sleep(100);
      expect(isProcessAlive(pid)).toBe(false);
      frozenPids.push(pid);
    }
  });

  it('kills a self-failed worker that stalls to "failed" (SIGKILL, not frozen)', async () => {
    const handle = `stall-failed-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_POLL_MS = "50";
    process.env.WORKER_STALL_MS = "200";

    const r = await runWorker(
      fakeScript("echo; echo FAILED; sleep 20"),
      REPO,
      handle,
      "cmd",
      lp,
      "",
      60_000,
    );
    expect(r.status).toBe("failed");
    expect(r.exit_code).toBe(124);
  }, 30_000);

  it('kills a productive worker at deadline+grace when nobody extends → "timeout"', async () => {
    const handle = `grace-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_POLL_MS = "50";
    process.env.WORKER_GRACE_MS = "150";

    const r = await runWorker(
      fakeScript("while true; do echo working; sleep 0.1; done"),
      REPO,
      handle,
      "cmd",
      lp,
      "",
      200,
    );
    expect(r.status).toBe("timeout");
    expect(r.exit_code).toBe(124);
    expect(getJob(handle)?.status).toBe("timeout");
  }, 30_000);

  it("does NOT kill when the deadline is pushed out (worker_extend) before grace expires", async () => {
    const handle = `extend-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_POLL_MS = "50";
    process.env.WORKER_GRACE_MS = "150";

    setTimeout(
      () => updateJob(handle, { deadline_at: Date.now() + 60_000 }),
      120,
    ).unref?.();
    const r = await runWorker(
      fakeScript(
        `for i in 1 2 3; do echo working $i; sleep 0.1; done; echo work > ${handle}.out; echo; echo DONE`,
      ),
      REPO,
      handle,
      "cmd",
      lp,
      "",
      100,
    );
    expect(r.status).toBe("done");
  });

  it('resolves "killed" when kill_requested is set and the worker ends non-done (kill precedence)', async () => {
    const handle = `killed-${seq}`;
    const lp = seedJob(handle);
    updateJob(handle, { kill_requested: true });
    const r = await runWorker(
      fakeScript("echo FAILED\nexit 1"),
      REPO,
      handle,
      "cmd",
      lp,
      "",
    );
    expect(r.status).toBe("killed");
    expect(getJob(handle)?.status).toBe("killed");
  });

  it('resolves "failed" when the spawn errors before the process starts', async () => {
    const handle = `spawn-err-${seq}`;
    const lp = seedJob(handle);

    const nonExistentDir = join(tmpdir(), `nonexistent-${process.pid}`);
    const badScriptPath = join(nonExistentDir, "fake.cmd");
    try {
      rmSync(nonExistentDir, { recursive: true, force: true });
    } catch {}

    const r = await runWorker(
      ["bash", badScriptPath],
      REPO,
      handle,
      "cmd",
      lp,
      "",
    );
    expect(r.status).toBe("failed");
  });
});

function realStart(pid: number): string {
  const r = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return new Date(
    Date.now() - (parseEtimeSeconds(r.stdout) ?? 0) * 1000,
  ).toISOString();
}

describe("isProcessAlive PID-reuse guard", () => {
  it("returns true for a live pid and false for a dead pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    const dead = spawnSync("true");
    expect(isProcessAlive(dead.pid ?? 999999)).toBe(false);
  });

  it("accepts a matching start and rejects one that skews from the real process start (reuse defense)", () => {
    expect(isProcessAlive(process.pid, realStart(process.pid))).toBe(true);

    const skewed = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    expect(isProcessAlive(process.pid, skewed)).toBe(false);
  });
});

describe("parseEtimeSeconds", () => {
  it("parses every ps etime shape and rejects junk", () => {
    expect(parseEtimeSeconds("00:01")).toBe(1);
    expect(parseEtimeSeconds("05:23")).toBe(323);
    expect(parseEtimeSeconds("01:05:23")).toBe(3923);
    expect(parseEtimeSeconds("2-01:05:23")).toBe(176723);
    expect(parseEtimeSeconds("  03:04  ")).toBe(184);
    expect(parseEtimeSeconds("garbage")).toBeNull();
    expect(parseEtimeSeconds("")).toBeNull();
  });
});

describe("reapStoppedJobs (stale frozen-job reaper)", () => {
  const REAP_DIR = join(tmpdir(), `wrunner-reap-${process.pid}`);
  let prevStateDir: string;
  beforeAll(() => {
    prevStateDir = process.env.WORKER_STATE_DIR!;
    process.env.WORKER_STATE_DIR = REAP_DIR;
  });
  afterAll(() => {
    process.env.WORKER_STATE_DIR = prevStateDir;
    try {
      rmSync(REAP_DIR, { recursive: true, force: true });
    } catch {}
  });

  it('kills an alive frozen job past the reap window and finalizes it "timeout"', async () => {
    const handle = `reap-old-${seq}`;
    const lp = seedJob(handle);
    const pid = spawnDetached("sleep 100", lp);

    updateJob(handle, {
      status: "stopped",
      worker_pid: pid,
      stopped_at: "2020-01-01T00:00:00.000Z",
    });
    process.env.WORKER_REAP_MS = "100";
    reapStoppedJobs();
    expect(getJob(handle)?.status).toBe("timeout");
    await Bun.sleep(100);
    expect(isProcessAlive(pid)).toBe(false);
    frozenPids.push(pid);
  });

  it("leaves a freshly frozen job (within the window) untouched", () => {
    const handle = `reap-fresh-${seq}`;
    const lp = seedJob(handle);
    const pid = spawnDetached("sleep 100", lp);
    updateJob(handle, {
      status: "stopped",
      worker_pid: pid,
      stopped_at: new Date().toISOString(),
    });

    reapStoppedJobs();
    expect(getJob(handle)?.status).toBe("stopped");
    expect(isProcessAlive(pid)).toBe(true);
    frozenPids.push(pid);
  });

  it('finalizes a frozen job whose pid is already dead as "failed:server-restart"', () => {
    const handle = `reap-dead-${seq}`;
    seedJob(handle);
    const dead = spawnSync("true");
    updateJob(handle, {
      status: "stopped",
      worker_pid: dead.pid ?? 999999,
      stopped_at: new Date().toISOString(),
    });
    reapStoppedJobs();
    expect(getJob(handle)?.status).toBe("failed:server-restart");
  });
});
