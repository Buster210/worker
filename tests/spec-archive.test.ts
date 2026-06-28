import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
} from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const STATE_DIR = join(tmpdir(), `spec-arch-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;

const TEST_HOME = join(tmpdir(), `spec-arch-home-${process.pid}`);
const ORIG_HOME = process.env.HOME;
process.env.HOME = TEST_HOME;
afterAll(() => {
  process.env.HOME = ORIG_HOME;
});
const PLANS_DIR = join(TEST_HOME, ".claude", "plans");
process.env.WORKER_PLANS_DIR = PLANS_DIR;

import {
  insertJob,
  finalizeJob,
  workersDir,
  plansWorkerDir,
  archiveSpec,
  __resetStateForTest,
} from "../src/state.ts";
import { sweepStaleWorkerDirs } from "../src/maintenance.ts";

const REPO = join(tmpdir(), `spec-arch-repo-${process.pid}`);
let seq = 0;

function createTestJob(
  fields: { status?: string; spec_file?: string; finished?: string } = {},
): string {
  const handle = `sarch-${process.pid}-${seq++}`;
  const dir = join(workersDir(), "test-repo", handle);
  mkdirSync(dir, { recursive: true });
  const jobData = {
    handle,
    backend: "claude",
    sid: "test-sid",
    repo: REPO,
    log_path: join(dir, "run.log"),
    worker_pid: 0,
    resume_token: "",
    model: "haiku",
    task: "test task",
    status: fields.status ?? "running",
    started: new Date().toISOString(),
    finished: fields.finished,
    server_pid: 0,
    server_started: new Date().toISOString(),
    server_sid: "test-sid",
    completion_lock: join(dir, ".lock"),
    spec_file: fields.spec_file,
  };
  writeFileSync(join(dir, "job.json"), JSON.stringify(jobData));
  insertJob({
    handle,
    backend: "claude",
    sid: "test-sid",
    repo: REPO,
    log_path: join(dir, "run.log"),
    spec_file: fields.spec_file,
  });
  return handle;
}

function createTestSpec(filename: string): string {
  mkdirSync(PLANS_DIR, { recursive: true });
  const path = join(PLANS_DIR, filename);
  writeFileSync(path, `Test spec content for ${filename}`);
  return path;
}

beforeEach(() => {
  __resetStateForTest();
  rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(PLANS_DIR, { recursive: true });
  seq = 0;
});

afterEach(() => {
  __resetStateForTest();
  rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("spec-archive", () => {
  it("archiveSpec moves plans/<spec> → plans/worker/<spec> when job.spec_file set and status done", () => {
    const specName = "test-spec.txt";
    createTestSpec(specName);

    const handle = createTestJob({ spec_file: specName });
    const specPath = join(PLANS_DIR, specName);
    const archivedPath = join(plansWorkerDir(), specName);

    expect(existsSync(specPath)).toBe(true);
    expect(existsSync(archivedPath)).toBe(false);

    finalizeJob(handle, "done");

    archiveSpec(handle);

    expect(existsSync(specPath)).toBe(false);
    expect(existsSync(archivedPath)).toBe(true);
    expect(readFileSync(archivedPath, "utf8")).toBe(
      `Test spec content for ${specName}`,
    );
  });

  it("archiveSpec is no-op when spec_file absent in job", () => {
    const handle = createTestJob({ spec_file: undefined });
    const specName = "orphan-spec.txt";
    createTestSpec(specName);
    const specPath = join(PLANS_DIR, specName);

    expect(existsSync(specPath)).toBe(true);

    archiveSpec(handle);

    expect(existsSync(specPath)).toBe(true);
  });

  it("archiveSpec is idempotent when spec file already missing", () => {
    const specName = "missing-spec.txt";
    const handle = createTestJob({ spec_file: specName });

    const specPath = join(PLANS_DIR, specName);
    expect(existsSync(specPath)).toBe(false);

    expect(() => archiveSpec(handle)).not.toThrow();
    expect(existsSync(specPath)).toBe(false);
  });

  it("archiveSpec is idempotent when spec already in plans/worker/", () => {
    const specName = "already-archived.txt";
    const archivedPath = join(plansWorkerDir(), specName);
    const specPath = join(PLANS_DIR, specName);

    mkdirSync(plansWorkerDir(), { recursive: true });
    writeFileSync(archivedPath, "Test spec content");

    const handle = createTestJob({ spec_file: specName });

    expect(() => archiveSpec(handle)).not.toThrow();

    expect(existsSync(archivedPath)).toBe(true);
    expect(existsSync(specPath)).toBe(false);
  });

  it("sweepStaleWorkerDirs removes archived spec for done dir", () => {
    const specName = "sweep-spec.txt";
    createTestSpec(specName);
    const handle = createTestJob({
      status: "done",
      spec_file: specName,
      finished: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    });
    const dir = join(workersDir(), "test-repo", handle);

    archiveSpec(handle);
    const archivedPath = join(plansWorkerDir(), specName);
    expect(existsSync(archivedPath)).toBe(true);

    sweepStaleWorkerDirs();

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(archivedPath)).toBe(false);
  });

  it("sweepStaleWorkerDirs does NOT remove spec for killed:no-client dir", () => {
    const specName = "killed-spec.txt";
    createTestSpec(specName);

    const handle = createTestJob({
      status: "killed:no-client",
      spec_file: specName,
    });
    const dir = join(workersDir(), "test-repo", handle);

    archiveSpec(handle);
    const archivedPath = join(plansWorkerDir(), specName);
    expect(existsSync(archivedPath)).toBe(true);

    sweepStaleWorkerDirs();

    expect(existsSync(dir)).toBe(true);
    expect(existsSync(archivedPath)).toBe(true);
  });

  it("sweepStaleWorkerDirs does NOT remove spec for non-terminal dir", () => {
    const specName = "running-spec.txt";
    createTestSpec(specName);

    const handle = createTestJob({ status: "running", spec_file: specName });
    const dir = join(workersDir(), "test-repo", handle);

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".lock"), "");

    const specPath = join(PLANS_DIR, specName);
    expect(existsSync(specPath)).toBe(true);

    sweepStaleWorkerDirs();

    expect(existsSync(dir)).toBe(true);
    expect(existsSync(specPath)).toBe(true);
  });

  it("rejects a traversal spec_file read from a tampered job.json (no escape from plans/worker)", () => {
    mkdirSync(plansWorkerDir(), { recursive: true });
    const sentinel = join(PLANS_DIR, "escape.txt");
    writeFileSync(sentinel, "must survive");

    const handle = createTestJob({
      status: "done",
      spec_file: "../escape.txt",
      finished: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    });
    const dir = join(workersDir(), "test-repo", handle);

    archiveSpec(handle);
    expect(existsSync(sentinel)).toBe(true);

    // sweep removes the dir but must NOT unlink the out-of-tree sentinel
    sweepStaleWorkerDirs();
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(sentinel)).toBe(true);
  });
});
