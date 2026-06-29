import {
  describe,
  it,
  expect,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { spawnSync } from "child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const STATE_DIR_RAW = join(tmpdir(), `wcommit-state-${process.pid}`);
mkdirSync(STATE_DIR_RAW, { recursive: true });
const STATE_DIR = realpathSync(STATE_DIR_RAW);
process.env.WORKER_STATE_DIR = STATE_DIR;

import { maybeVerifyAndCommit, resolveStatus } from "../src/runner.ts";
import {
  insertJob,
  updateJob,
  finalizeJob,
  getJobFresh,
} from "../src/state.ts";
import { renderReport } from "../src/report.ts";

const REPO_RAW = mkdtempSync(join(tmpdir(), "wcommit-repo-"));
const REPO = realpathSync(REPO_RAW);

function git(...args: string[]) {
  return spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
}

git("init", "-q");
git("config", "user.email", "test@test.com");
git("config", "user.name", "Test");
writeFileSync(join(REPO, "README.md"), "init\n");
git("add", ".");
git("commit", "-m", "init", "--no-gpg-sign");

const tmpDirs: string[] = [REPO, STATE_DIR];

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

let seq = 0;
function seedJob(task = "test task"): string {
  const handle = `commit-${process.pid}-${seq++}`;
  insertJob({
    handle,
    backend: "cmd",
    sid: "test",
    repo: REPO,
    log_path: "/tmp/commit-test.log",
    task,
  });
  return handle;
}

function commitCount(dir: string = REPO): number {
  const r = spawnSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], {
    encoding: "utf8",
  });
  return parseInt(r.stdout.trim(), 10);
}

function isClean(dir: string = REPO): boolean {
  const r = spawnSync("git", ["-C", dir, "status", "--porcelain"], {
    encoding: "utf8",
  });
  return r.stdout.trim() === "";
}

function baseSha(dir: string = REPO): string {
  return spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
}

describe("maybeVerifyAndCommit — pass-through on non-done", () => {
  it('returns "failed" unchanged, makes no commit', async () => {
    const handle = seedJob();
    const before = commitCount();

    writeFileSync(join(REPO, `dirty-${seq}.txt`), "x\n");
    const result = await maybeVerifyAndCommit(handle, REPO, "failed");
    expect(result).toBe("failed");
    expect(commitCount()).toBe(before);
  });

  it('returns "timeout" unchanged, makes no commit', async () => {
    const handle = seedJob();
    const before = commitCount();
    writeFileSync(join(REPO, `dirty-${seq}.txt`), "x\n");
    const result = await maybeVerifyAndCommit(handle, REPO, "timeout");
    expect(result).toBe("timeout");
    expect(commitCount()).toBe(before);
  });
});

describe("maybeVerifyAndCommit — commits on done", () => {
  it('with a dirty tree: makes exactly ONE commit, returns "done", working tree is clean', async () => {
    const handle = seedJob();
    const before = commitCount();
    writeFileSync(join(REPO, `change-${seq}.txt`), "hello\n");
    const result = await maybeVerifyAndCommit(handle, REPO, "done");
    expect(result).toBe("done");
    expect(commitCount()).toBe(before + 1);
    expect(isClean()).toBe(true);
  });

  it('with nothing to commit (already clean): returns "failed:no-changes" and makes no commit', async () => {
    const before = commitCount();
    const handle = seedJob();
    const result = await maybeVerifyAndCommit(handle, REPO, "done");
    expect(result).toBe("failed:no-changes");
    expect(commitCount()).toBe(before);
  });

  it("backend self-committed (tree clean but HEAD moved past baseSha): returns \"done\", makes no extra commit", async () => {
    const startSha = baseSha();
    const handle = seedJob();
    writeFileSync(join(REPO, `self-committed-${seq}.txt`), "x\n");
    git("add", ".");
    git("commit", "-m", "backend self-commit", "--no-gpg-sign");
    const before = commitCount();
    const result = await maybeVerifyAndCommit(handle, REPO, "done", startSha);
    expect(result).toBe("done");
    expect(commitCount()).toBe(before);
  });
});

describe("maybeVerifyAndCommit — WORKER_VERIFY_CMD gate", () => {
  let origVerifyCmd: string | undefined;

  beforeEach(() => {
    origVerifyCmd = process.env.WORKER_VERIFY_CMD;
  });
  afterEach(() => {
    if (origVerifyCmd === undefined) delete process.env.WORKER_VERIFY_CMD;
    else process.env.WORKER_VERIFY_CMD = origVerifyCmd;
  });

  it('WORKER_VERIFY_CMD="exit 1" on done → returns "failed:verify", NO commit', async () => {
    process.env.WORKER_VERIFY_CMD = "exit 1";
    const handle = seedJob();
    const before = commitCount();
    writeFileSync(join(REPO, `verify-fail-${seq}.txt`), "x\n");
    const result = await maybeVerifyAndCommit(handle, REPO, "done");
    expect(result).toBe("failed:verify");
    expect(commitCount()).toBe(before);
  });

  it('WORKER_VERIFY_CMD="true" on done → commits, returns "done"', async () => {
    process.env.WORKER_VERIFY_CMD = "true";
    const handle = seedJob();
    const before = commitCount();
    writeFileSync(join(REPO, `verify-pass-${seq}.txt`), "y\n");
    const result = await maybeVerifyAndCommit(handle, REPO, "done");
    expect(result).toBe("done");
    expect(commitCount()).toBe(before + 1);
  });

  it('unset WORKER_VERIFY_CMD on done → skips verify, commits, returns "done"', async () => {
    delete process.env.WORKER_VERIFY_CMD;
    const handle = seedJob();
    const before = commitCount();
    writeFileSync(join(REPO, `verify-unset-${seq}.txt`), "z\n");
    const result = await maybeVerifyAndCommit(handle, REPO, "done");
    expect(result).toBe("done");
    expect(commitCount()).toBe(before + 1);
  });
});

describe("maybeVerifyAndCommit — excludes .codegraph", () => {
  it("does not commit the .codegraph symlink when real changes exist", async () => {
    const handle = seedJob("codegraph exclusion test");
    const before = commitCount();
    const fileName = `codegraph-${seq}.txt`;
    writeFileSync(join(REPO, fileName), "real change\n");
    symlinkSync(REPO, join(REPO, ".codegraph"));

    const result = await maybeVerifyAndCommit(handle, REPO, "done");
    expect(result).toBe("done");
    expect(commitCount()).toBe(before + 1);

    const show = spawnSync(
      "git",
      ["-C", REPO, "show", "--pretty=format:", "--name-only", "HEAD"],
      { encoding: "utf8" },
    );
    expect(show.stdout).toContain(fileName);
    expect(show.stdout).not.toContain(".codegraph");

    unlinkSync(join(REPO, ".codegraph"));
  });

  it("commits when .codegraph is ignored and present (worktree add regression)", async () => {
    const handle = seedJob("codegraph ignored test");
    const before = commitCount();
    const fileName = `codegraph-ignored-${seq}.txt`;
    writeFileSync(join(REPO, fileName), "real change\n");
    // Production ignores .codegraph via .git/info/exclude; the old
    // `git add -A -- ':!.codegraph'` exited 1 on an ignored path named by a
    // pathspec, failing every commit whenever .codegraph existed.
    writeFileSync(join(REPO, ".git/info/exclude"), ".codegraph\n");
    symlinkSync(REPO, join(REPO, ".codegraph"));

    const result = await maybeVerifyAndCommit(handle, REPO, "done");
    expect(result).toBe("done");
    expect(commitCount()).toBe(before + 1);

    const show = spawnSync(
      "git",
      ["-C", REPO, "show", "--pretty=format:", "--name-only", "HEAD"],
      { encoding: "utf8" },
    );
    expect(show.stdout).toContain(fileName);
    expect(show.stdout).not.toContain(".codegraph");

    unlinkSync(join(REPO, ".codegraph"));
    writeFileSync(join(REPO, ".git/info/exclude"), "");
  });
});

describe("base-ref diff — committed work still surfaces", () => {
  it("plain git diff is empty after commit but base-ref diff shows the change", async () => {
    const base = baseSha();
    const handle = seedJob("base-ref test");

    const fileName = `base-ref-${seq}.txt`;
    writeFileSync(join(REPO, fileName), "committed content\n");
    const result = await maybeVerifyAndCommit(handle, REPO, "done");
    expect(result).toBe("done");
    expect(isClean()).toBe(true);

    const plainDiff = spawnSync("git", ["-C", REPO, "diff"], {
      encoding: "utf8",
    });
    expect(plainDiff.stdout.trim()).toBe("");

    const baseDiff = spawnSync("git", ["-C", REPO, "diff", base], {
      encoding: "utf8",
    });
    expect(baseDiff.stdout).toContain(fileName);
    expect(baseDiff.stdout).toContain("committed content");
  });

  it("renderReport with base_sha on a done job passes base_sha to the diff fn", async () => {
    const base = baseSha();

    const handle = `commit-render-${process.pid}-${seq++}`;
    insertJob({
      handle,
      backend: "cmd",
      sid: "test",
      repo: REPO,
      log_path: "/tmp/x.log",
      task: "render base_sha test",
      base_sha: base,
    });
    updateJob(handle, {
      status: "done",
      finished: new Date().toISOString(),
      worktree_path: REPO,
      base_sha: base,
    });

    let capturedBaseSha: string | undefined = "NOT_CALLED";
    renderReport(handle, `/any/${handle}/.lock`, (_repo, sha) => {
      capturedBaseSha = sha;
      return "DIFFBODY";
    });
    expect(capturedBaseSha).toBe(base);
  });
});

describe("integration — wired completion sequence commits on a real worktree", () => {
  it("resolveStatus done → maybeVerifyAndCommit → finalizeJob lands one commit, base-ref diff shows it", async () => {
    const WT = realpathSync(mkdtempSync(join(tmpdir(), "wcommit-wt-")));
    tmpDirs.push(WT);
    const g = (...a: string[]) =>
      spawnSync("git", ["-C", WT, ...a], { encoding: "utf8" });
    g("init", "-q");
    g("config", "user.email", "test@test.com");
    g("config", "user.name", "Test");
    writeFileSync(join(WT, "README.md"), "init\n");
    g("add", ".");
    g("commit", "-m", "init", "--no-gpg-sign");

    const base = g("rev-parse", "HEAD").stdout.trim();

    const emptyLog = join(WT, "run.log");
    writeFileSync(emptyLog, "");

    const handle = `commit-integ-${process.pid}-${seq++}`;
    insertJob({
      handle,
      backend: "cmd",
      sid: "test",
      repo: WT,
      worktree_path: WT,
      base_sha: base,
      log_path: emptyLog,
      task: "integration wired commit",
    });

    writeFileSync(join(WT, "feature.txt"), "real work product\n");

    const before = commitCount(WT);

    const natural = resolveStatus("cmd", 0, emptyLog, false);
    expect(natural).toBe("done");
    const gated = await maybeVerifyAndCommit(handle, WT, natural);
    const status = finalizeJob(handle, gated, { resume_token: "" });

    expect(status).toBe("done");
    expect(commitCount(WT)).toBe(before + 1);
    expect(isClean(WT)).toBe(true);

    expect(
      spawnSync("git", ["-C", WT, "diff"], { encoding: "utf8" }).stdout.trim(),
    ).toBe("");
    const baseDiff = spawnSync("git", ["-C", WT, "diff", base], {
      encoding: "utf8",
    });
    expect(baseDiff.stdout).toContain("feature.txt");
    expect(baseDiff.stdout).toContain("real work product");

    expect(getJobFresh(handle)?.base_sha).toBe(base);
  });
});
