import { spawn, spawnSync } from "child_process";
import { rmSync } from "fs";
import { isAbsolute, join } from "path";
import { handleDirUncached } from "./state.ts";
export function addWorktree(repo: string, handle: string): string {
  const path = join(handleDirUncached(handle, repo), "tree");
  const branch = `worker/${handle}`;
  const r = spawnSync(
    "git",
    ["-C", repo, "worktree", "add", "-b", branch, path, "HEAD"],
    { encoding: "utf8" },
  );
  if (r.error)
    throw new Error(`worktree add failed for ${handle}: ${r.error.message}`);
  if (r.status !== 0)
    throw new Error(`worktree add failed for ${handle}: ${r.stderr ?? ""}`);
  return path;
}

// Concurrent `git worktree add` on one repo races two ways: the .git/config.lock / worktrees lock,
// and — because every worktree leaf is named `tree`, so git auto-numbers the admin ids tree/tree1/…
// non-atomically — a read of a sibling's half-written .git/worktrees/treeN/commondir. Both are
// transient: a staggered retry lets the winning sibling finish, then the loser gets a fresh id.
// ponytail: bounded jittered retry on the transient git-races only; real errors (branch exists, bad
// HEAD) don't match and fail fast. If contention ever outlasts the budget, raise the retry cap.
const WORKTREE_ADD_RETRIES = 6;
const WORKTREE_ADD_TRANSIENT =
  /lock|commondir|failed to read|Undefined error|No such file/i;

let _addQueue: Promise<unknown> = Promise.resolve();

function gitWorktreeAdd(
  repo: string,
  handle: string,
  path: string,
  branch: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const run = async () => {
      for (let attempt = 1; ; attempt++) {
        const err = await new Promise<string | null>((res) => {
          const stderr: Buffer[] = [];
          const p = spawn(
            "git",
            ["-C", repo, "worktree", "add", "-b", branch, path, "HEAD"],
            { stdio: ["ignore", "ignore", "pipe"] },
          );
          p.stderr?.on("data", (d: Buffer) => stderr.push(d));
          p.on("close", (code) =>
            res(code === 0 ? null : Buffer.concat(stderr).toString().trim()),
          );
          p.on("error", (e) => res(e.message));
        });
        if (err === null) return;
        if (
          attempt >= WORKTREE_ADD_RETRIES ||
          !WORKTREE_ADD_TRANSIENT.test(err)
        ) {
          throw new Error(`worktree add failed for ${handle}: ${err}`);
        }
        await new Promise((r) =>
          setTimeout(r, attempt * 40 + Math.floor(Math.random() * 60)),
        );
      }
    };
    const done = _addQueue.then(run, run);
    _addQueue = done.catch(() => {});
    done.then(resolve, reject);
  });
}

export async function addWorktreeAsync(
  repo: string,
  handle: string,
): Promise<string> {
  const path = join(handleDirUncached(handle, repo), "tree");
  const branch = `worker/${handle}`;
  await gitWorktreeAdd(repo, handle, path, branch);
  return path;
}

export function removeWorktree(repo: string, path: string): void {
  // ponytail: G6 wires reaping — do NOT call from finalizeJob or hot path
  try {
    spawnSync("git", ["-C", repo, "worktree", "remove", "--force", path], {
      encoding: "utf8",
    });
  } catch {}
  try {
    const parts = path.split("/");
    const handle = parts[parts.length - 2]; // path = .../workers/<project>/<handle>/tree
    spawnSync("git", ["-C", repo, "branch", "-D", `worker/${handle}`], {
      encoding: "utf8",
    });
  } catch {}
}

// A SIGKILL'd rung can leave .git/index.lock in the worktree it was using, which blocks every git
// op of the next rung that reuses it. Safe to clear: the ladder reuses a worktree only after its
// prior occupant has terminated (stall→SIGKILL or fail→exit), so there is no live writer.
// ponytail: no live-process check — reuse-after-termination is the only caller; if that ever stops
// holding, gate on `git rev-parse` of the lock's pid instead.
export function clearStaleIndexLock(worktree: string): void {
  const r = spawnSync(
    "git",
    ["-C", worktree, "rev-parse", "--git-path", "index.lock"],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || typeof r.stdout !== "string") return;
  const rel = r.stdout.trim();
  if (!rel) return;
  const abs = isAbsolute(rel) ? rel : join(worktree, rel);
  try {
    rmSync(abs, { force: true });
  } catch {}
}

export function listWorktrees(repo: string): string[] {
  const r = spawnSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  });
  if (r.error || typeof r.stdout !== "string") return [];
  const paths: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree "))
      paths.push(line.slice("worktree ".length).trim());
  }
  return paths;
}
