# worker-mcp

MCP server (Bun + `@modelcontextprotocol/sdk`) that delegates coding tasks to background agents — Claude, Codex, OpenCode, OMP, or a generic pool — each in an isolated git worktree.

## Quick start

```bash
bun install
bun run dev          # watch mode — MCP server on stdio
```

Or build for distribution:

```bash
bun run build        # dist/server.js, dist/report.js, dist/reaper.js
bun run start        # run built server
```

## MCP tools

| Tool | What it does |
|---|---|
| `worker_ladder` | **Default.** Run a task on the best available backend; auto-climbs the ladder on failure. |
| `worker_run` | Run on a named backend (use only when the user names one). |
| `worker_resume` | Resume a stopped worker or retry a failed/timed-out one. |
| `worker_kill` | Kill a running worker. |
| `worker_status` | Get worker state: status, pid, timing. |
| `worker_extend` | Push deadline forward by N seconds (repeatable). |
| `worker_list` | List recent jobs, optionally filtered by status. |
| `worker_doctor` | Health check — names broken workers, or reports all-fine. |
| `worker_cleanup` | Drop transcript (`run.log`) after diff review. |

## How it works

```
caller → MCP server (server.ts)
           → chain.ts: handleLadder (retry-once-then-climb)
               → lifecycle.ts: launch (worktree, spawn, deadline)
                   → runner.ts: runWorker (stall/timeout watchdog)
                       → runner.ts: maybeVerifyAndCommit (verify gate → git add + commit)
           → daemon.ts (lockfile, session tracking, self-termination)
           → maintenance.ts (sweep stale jobs, reap stopped workers)
```

1. A spec file (`~/.claude/plans/<name>`) describes the task.
2. `worker_ladder` picks the highest-priority authed backend from the ladder and spawns the agent in a git worktree (or the repo itself if idle).
3. A watchdog monitors the log for stalls and timeouts.
4. On success, the worker stages and commits changes (gated by `verifyCmd` if configured).
5. `worker-report <handle>` (CLI) waits for completion and shows the diff.

Concurrent workers each get their own worktree (`worker/<handle>` branch). The first worker uses the repo in-place.

## Configuration

`~/.claude/workers/config.json` (all fields optional):

```jsonc
{
  // Backend priority, highest first
  "ladder": ["codex", "cmd", "pool", "omp", "opencode", "claude"],
  // Backends to remove from the ladder
  "skip": [],
  // Shell command run before commit; non-zero aborts commit
  "verifyCmd": "",
  // Worker state dir (default ~/.claude/workers)
  "stateDir": "",
  // Spec-file dir (default ~/.claude/plans)
  "plansDir": "",
  // Finished-job retention (ms, 0 = default)
  "retainMs": 0,
  // Shell rc file sourced for spawn env
  "rc": "",
  // Source login shell to capture env for spawns
  "loginShell": true
}
```

See `config.example.jsonc` for the full reference.

### Environment variables

All follow `envMs("WORKER_<NAME>", default)` in `env.ts`:

| Variable | Default | Purpose |
|---|---|---|
| `WORKER_TIMEOUT_MS` | 600000 | Hard timeout per worker (10 min) |
| `WORKER_STALL_MS` | 60000 | Stall detection for thinking backends |
| `WORKER_STALL_MS_QUIET` | 240000 | Stall detection for quiet backends (e.g. Codex) |
| `WORKER_WATCHDOG_MS` | 5000 | Watchdog poll interval |
| `WORKER_REAP_MS` | 900000 | Reap age for stopped workers |
| `WORKER_GRACE_MS` | 60000 | Grace period before hard kill |
| `WORKER_NEAR_EXPIRY_MS` | 30000 | Near-deadline threshold |
| `WORKER_AUTH_PROBE_MS` | 2000 | Auth probe timeout |
| `WORKER_MAX_TURNS` | 10000 | Max agent turns |
| `WORKER_SKIP_AUTH_GATE` | — | Set to `1` to skip auth probe (tests/ops) |
| `WORKER_GPG_MODE` | — | `loopback`, `agent`, or `cache` |
| `WORKER_CONFIG_PATH` | — | Override config.json path |

## Report CLI

```bash
bun run src/report.ts <handle>     # wait for worker, show result + diff
bun run dist/report.js <handle>    # same, built version
```

## Build

```bash
bun run dev          # watch mode
bun run build        # bundle to dist/
bun run typecheck    # tsgo --noEmit
bun test             # 355 tests
```

Tests: 24 in `tests/`, 2 co-located (`src/stageDelta.test.ts`, `src/gpgSign.test.ts`) — 26 files, 355 tests.

## State layout

```
~/.claude/workers/
  <project>/
    <handle>/
      job.json        # job metadata
      .lock           # lockfile
      run.log         # agent output
      tree/           # git worktree (concurrent workers only)
  ladder/
    <sid>.jsonl       # ladder history
    <sid>.chain.lock  # chain lockfile
    <sid>.chain.meta  # chain deadline sidecar
  server.json         # daemon lockfile (pid + port)
  .reaper.pid         # reaper process pid
```
