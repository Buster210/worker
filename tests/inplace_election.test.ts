import { describe, it, expect, afterEach, afterAll } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const STATE_DIR = join(tmpdir(), `wstate-election-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;

import {
  insertJob,
  isInPlaceOwner,
  __resetStateForTest,
} from "../src/state.ts";

const REPO = "/tmp/election-test-repo";

afterAll(() => {
  try {
    rmSync(STATE_DIR, { recursive: true, force: true });
  } catch {}
});

afterEach(() => {
  __resetStateForTest();
  try {
    rmSync(STATE_DIR, { recursive: true, force: true });
  } catch {}
});

function makeJob(
  handle: string,
  created_at: number,
  opts?: { server_pid?: number; server_started?: string },
) {
  insertJob({
    handle,
    backend: "cmd",
    sid: "test-sid",
    repo: REPO,
    log_path: `/tmp/${handle}.log`,
    created_at,
    server_pid: opts?.server_pid ?? process.pid,

    server_started: opts?.server_started,
  });
}

describe("isInPlaceOwner", () => {
  it("exactly one owner among concurrent batch (equal created_at, tie broken by handle)", () => {
    const ts = Date.now();
    const handles = ["zzz-job", "aaa-job", "mmm-job"];
    for (const h of handles) makeJob(h, ts);

    const owners = handles.filter((h) => isInPlaceOwner(h, REPO));
    expect(owners).toEqual(["aaa-job"]);
  });

  it("older job is sole owner even when younger job has lexicographically smaller handle", () => {
    const older = 1000;
    const younger = 2000;
    makeJob("old-handle", older);
    makeJob("zzz-young", younger);

    expect(isInPlaceOwner("old-handle", REPO)).toBe(true);
    expect(isInPlaceOwner("zzz-young", REPO)).toBe(false);
  });

  it("dead-server job does not block election", () => {
    const ts = Date.now();
    makeJob("dead-job", ts, {
      server_pid: 999999,
      server_started: "2000-01-01T00:00:00.000Z",
    });
    makeJob("live-job", ts + 1);

    expect(isInPlaceOwner("live-job", REPO)).toBe(true);
  });

  it("returns false for missing handle", () => {
    expect(isInPlaceOwner("nonexistent", REPO)).toBe(false);
  });

  it("returns false when another alive older job exists", () => {
    makeJob("older", 1000);
    makeJob("younger", 2000);

    expect(isInPlaceOwner("younger", REPO)).toBe(false);
    expect(isInPlaceOwner("older", REPO)).toBe(true);
  });
});
