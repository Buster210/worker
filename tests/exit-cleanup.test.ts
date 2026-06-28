import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync, rmSync } from "fs";

const STATE_DIR = join(tmpdir(), `wexit-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;

import {
  shutdown,
  trackLaunched,
  resetShutdownState,
} from "../src/lifecycle.ts";
import {
  insertJob,
  updateJob,
  getJob,
  logPath as stateLogPath,
} from "../src/state.ts";

const REPO = "/tmp/wexit-repo";

beforeEach(() => {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(REPO, { recursive: true });
  resetShutdownState();
});

afterEach(() => {
  try {
    rmSync(STATE_DIR, { recursive: true, force: true });
  } catch {}
});

function seedJob(
  status: string,
  opts: { pid?: number; token?: string } = {},
): string {
  const handle = `wexit-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  insertJob({
    handle,
    backend: "cmd",
    sid: "test",
    repo: REPO,
    log_path: stateLogPath(handle, REPO),
  });
  const fields: { status: string; worker_pid?: number; resume_token?: string } =
    { status };
  if (opts.pid !== undefined) fields.worker_pid = opts.pid;
  if (opts.token !== undefined) fields.resume_token = opts.token;
  updateJob(handle, fields);
  return handle;
}

function stubExit(): { calls: number } {
  const state = { calls: 0 };
  spyOn(process, "exit").mockImplementation((..._args: unknown[]) => {
    state.calls++;
    return undefined as never;
  });
  return state;
}

describe("shutdown", () => {
  it("kills only tracked handles, finalizes them resumable with resume_token", async () => {
    const exitState = stubExit();

    const trackedRunning = seedJob("running", { pid: 12345, token: "tok-aaa" });
    const trackedStopped = seedJob("stopped", { pid: 12346, token: "tok-bbb" });
    const untracked = seedJob("running", { pid: 99999, token: "tok-xxx" });

    trackLaunched(trackedRunning);
    trackLaunched(trackedStopped);

    await shutdown();

    const j1 = getJob(trackedRunning)!;
    expect(j1.status).toBe("failed");
    expect(j1.resume_token).toBe("tok-aaa");

    const j2 = getJob(trackedStopped)!;
    expect(j2.status).toBe("failed");
    expect(j2.resume_token).toBe("tok-bbb");

    const j3 = getJob(untracked)!;
    expect(j3.status).toBe("running");
    expect(j3.resume_token).toBe("tok-xxx");

    expect(exitState.calls).toBe(1);
  });

  it("is idempotent on repeated calls", async () => {
    const exitState = stubExit();

    const h1 = seedJob("running", { pid: 20001, token: "t1" });
    const h2 = seedJob("running", { pid: 20002, token: "t2" });
    trackLaunched(h1);
    trackLaunched(h2);

    await shutdown();
    await shutdown();

    expect(exitState.calls).toBe(1);
    expect(getJob(h1)!.status).toBe("failed");
    expect(getJob(h2)!.status).toBe("failed");
  });

  it("skips kill for a stopped job without worker_pid", async () => {
    const exitState = stubExit();

    const h = seedJob("stopped", { token: "tok-nopid" });
    trackLaunched(h);

    await shutdown();

    expect(getJob(h)!.status).toBe("failed");
    expect(getJob(h)!.resume_token).toBe("tok-nopid");
    expect(exitState.calls).toBe(1);
  });
});
