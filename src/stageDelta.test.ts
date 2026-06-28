import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { dirtyPaths } from "./runner.ts";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

test("dirtyPaths lists untracked + modified, skips rename origin", async () => {
  const d = mkdtempSync(join(tmpdir(), "wt-"));
  try {
    git(d, "init", "-q");
    git(d, "config", "user.email", "t@t");
    git(d, "config", "user.name", "t");
    git(d, "config", "commit.gpgsign", "false");
    writeFileSync(join(d, "tracked.txt"), "v1\n");
    writeFileSync(join(d, "old.txt"), "keep\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "init");

    writeFileSync(join(d, "tracked.txt"), "v2\n"); // modified
    writeFileSync(join(d, "fresh.txt"), "new\n"); // untracked
    git(d, "mv", "old.txt", "new.txt"); // rename

    const paths = await dirtyPaths(d);
    expect(paths).toContain("tracked.txt");
    expect(paths).toContain("fresh.txt");
    expect(paths).toContain("new.txt");
    expect(paths).not.toContain("old.txt"); // rename origin skipped, not staged twice
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("fresh delta excludes the pre-existing snapshot and .codegraph", () => {
  const current = ["a.ts", "b.ts", "squash-proposal.md", ".codegraph"];
  const preexisting = new Set(["squash-proposal.md"]);
  const isCodegraph = (p: string) =>
    p === ".codegraph" || p.startsWith(".codegraph/");
  const fresh = current.filter(
    (p) => !isCodegraph(p) && !preexisting.has(p),
  );
  expect(fresh).toEqual(["a.ts", "b.ts"]);
});
