import { describe, it, expect, afterAll } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

const STATE_DIR = join(tmpdir(), `wchain-handle-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;

import { handleLadder } from "../src/chain.ts";
import {
  insertJob,
  getJobFresh,
  updateJob,
  finalizeJob,
  appendLadder,
  chainLockPath,
  __resetStateForTest,
} from "../src/state.ts";
import { terminalStatus } from "../src/report.ts";

afterAll(() => {
  try {
    rmSync(STATE_DIR, { recursive: true, force: true });
  } catch {}
});

const FULL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("chain handle format — runtime guarantee (claude --session-id safe)", () => {
  it("handleLadder mints a full-UUID handle and hands that exact handle to the first rung", () => {
    const launched: Array<string | undefined> = [];
    const stubLaunch = ((
      backend: string,
      _prompt: string,
      dir: string,
      opts: { handle?: string },
    ) => {
      launched.push(opts.handle);
      return {
        handle: opts.handle ?? "unset",
        promise: Promise.resolve({
          status: "done",
          exit_code: 0,
          backend,
          handle: opts.handle ?? "unset",
          resume_token: "",
          repo: dir,
          log: "",
        }),
        workdir: dir,
      };
    }) as unknown as NonNullable<Parameters<typeof handleLadder>[1]>["launch"];

    const res = handleLadder(
      { mcpSid: "m", prompt: "p", dir: "/tmp/test-repo" },
      { launch: stubLaunch },
    );
    if (!("handle" in res))
      throw new Error(
        `expected a running chain handle, got: ${JSON.stringify(res)}`,
      );

    expect(res.handle).toMatch(FULL_UUID);
    expect(res.handle.startsWith("w-")).toBe(false);
    expect(launched.length).toBeGreaterThan(0);
    expect(launched[0]).toBe(res.handle);
  });
});

describe("chain handle share — one handle, one job.json, live reconciliation", () => {
  it("rung1 fails → rung2 done: getJobFresh(handle) returns done, terminalStatus returns done", () => {
    __resetStateForTest();
    const chainHandle = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const sid = `chain-share-${process.pid}`;
    const repo = "/tmp/test-repo";

    insertJob({
      handle: chainHandle,
      backend: "cmd",
      sid,
      repo,
      log_path: "/tmp/run1.log",
    });
    finalizeJob(chainHandle, "failed");
    appendLadder(sid, 1, "cmd", "failed");

    insertJob({
      handle: chainHandle,
      backend: "omp",
      sid,
      repo,
      log_path: "/tmp/run2.log",
    });
    finalizeJob(chainHandle, "done");
    appendLadder(sid, 2, "omp", "done");

    const job = getJobFresh(chainHandle);
    expect(job).not.toBeNull();
    expect(job!.status).toBe("done");

    expect(terminalStatus(chainHandle, chainLockPath(sid))).toBe("done");
  });

  it("all rungs failed: terminalStatus returns exhausted", () => {
    __resetStateForTest();
    const chainHandle = "11111111-2222-3333-4444-555555555555";
    const sid = `chain-exhausted-${process.pid}`;
    const repo = "/tmp/test-repo";

    insertJob({
      handle: chainHandle,
      backend: "cmd",
      sid,
      repo,
      log_path: "/tmp/e1.log",
    });
    finalizeJob(chainHandle, "failed");
    appendLadder(sid, 1, "cmd", "failed");

    insertJob({
      handle: chainHandle,
      backend: "omp",
      sid,
      repo,
      log_path: "/tmp/e2.log",
    });
    finalizeJob(chainHandle, "failed");
    appendLadder(sid, 2, "omp", "failed");

    expect(getJobFresh(chainHandle)!.status).toBe("failed");
    expect(terminalStatus(chainHandle, chainLockPath(sid))).toBe("exhausted");
  });

  it("killed rung is terminal — not collapsed to exhausted", () => {
    __resetStateForTest();
    const chainHandle = "cccccccc-dddd-eeee-ffff-000000000000";
    const sid = `chain-killed-${process.pid}`;
    const repo = "/tmp/test-repo";

    insertJob({
      handle: chainHandle,
      backend: "cmd",
      sid,
      repo,
      log_path: "/tmp/k1.log",
    });
    finalizeJob(chainHandle, "failed");
    appendLadder(sid, 1, "cmd", "failed");

    insertJob({
      handle: chainHandle,
      backend: "omp",
      sid,
      repo,
      log_path: "/tmp/k2.log",
    });
    updateJob(chainHandle, { kill_requested: true });
    finalizeJob(chainHandle, "killed");
    appendLadder(sid, 2, "omp", "killed");

    expect(getJobFresh(chainHandle)!.status).toBe("killed");
    expect(terminalStatus(chainHandle, chainLockPath(sid))).toBe("killed");
  });

  it("threads stash fields into the reused rung after a failure", async () => {
    __resetStateForTest();
    const chainHandle = "99999999-aaaa-bbbb-cccc-dddddddddddd";
    const sid = `chain-stash-${process.pid}`;
    const repo = "/tmp/test-repo";
    const seen: Array<{ stashSha?: string; stashState?: string }> = [];

    const stubLaunch = ((backend: string, _prompt: string, dir: string, opts: any) => {
      seen.push({ stashSha: opts.stashSha, stashState: opts.stashState });
      const isFirst = seen.length === 1;
      insertJob({
        handle: opts.handle ?? chainHandle,
        backend,
        sid,
        repo,
        log_path: `/tmp/${backend}-${seen.length}.log`,
        worktree_path: dir,
        base_sha: "base",
        stash_sha: isFirst ? "stash-1" : opts.stashSha,
        stash_state: isFirst ? "stashed" : opts.stashState,
      });
      return {
        handle: opts.handle ?? chainHandle,
        promise: Promise.resolve({
          status: seen.length === 1 ? "failed" : "timeout",
          exit_code: 1,
          backend,
          handle: opts.handle ?? chainHandle,
          resume_token: "",
          repo: dir,
          log: "",
        }),
        workdir: dir,
      };
    }) as unknown as NonNullable<Parameters<typeof handleLadder>[1]>["launch"];

    handleLadder(
      { mcpSid: "m", prompt: "p", dir: repo },
      { launch: stubLaunch },
    );
    await Bun.sleep(20);

    expect(seen[1]?.stashSha).toBe("stash-1");
    expect(seen[1]?.stashState).toBe("stashed");
  });
});
