# worker-mcp

MCP server (Bun + `@modelcontextprotocol/sdk`) that delegates coding tasks to background agents — Claude, Codex, OpenCode, OMP, or a generic pool — each in an isolated git worktree.

## Installation

### Prerequisites

- Bun 1 or newer
- git
- At least one installed and authenticated backend CLI: `claude`, `codex`, `opencode`, `omp`, `pool`, or `cmd`
- The daemon prunes backends you do not have

### From source

```bash
git clone https://github.com/buster210/worker-mcp.git
cd worker-mcp
bun install
bun run build
```

### Setup Claude Code

```bash
bun run dist/install.js
```

This installs the daemon lifecycle hooks and MCP configuration. Claude Code will automatically start the daemon on session start and stop it when the last session ends.

### Platform

macOS and Linux only. Windows is unsupported.

### Uninstall

```bash
bun run dist/uninstall.js
```

## How it works

```
server.ts (MCP, session routing)
  → chain.ts:handleLadder (retry-once-then-climb)
    → lifecycle.ts:launch (worktree, spawn, deadline)
      → runner.ts:runWorker (stall/timeout watchdog)
        → runner.ts:maybeVerifyAndCommit (verify gate → git add + commit)
  → daemon.ts (lockfile, SessionTracker, self-termination)
  → maintenance.ts (sweep stale jobs, reap stopped workers)
```

1. A spec file (`~/.claude/plans/<name>`) describes the task.
2. The daemon (`server.ts`) routes to the best backend via `worker_ladder`.
3. Each backend spawns in an isolated git worktree with stall/timeout watchdogs.
4. On success, the worker auto-commits; on failure, the ladder climbs to the next backend.

Concurrent workers each get their own worktree (`worker/<handle>` branch). The first worker uses the repo in-place.

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

## Configuration

`~/.claude/workers/config.json` (all fields optional):

```jsonc
{
  "ladder": ["omp", "claude", "codex", "opencode", "pool"],
  "skip": [],
  "verifyCmd": "bun test",
  "stateDir": "~/.claude/workers",
  "retainMs": 86400000,
  "loginShell": "/bin/zsh",
  "cpuQos": 0.8,
  "gpgMode": "agent",
  "gpgKeygrip": ""
}
```

See `config.example.jsonc` for the full reference.

### Environment variables

All follow `envMs("WORKER_<NAME>", default)` in `env.ts`:

| Variable | Default | Purpose |
|---|---|---|
| `WORKER_TIMEOUT_MS` | 300000 | Max job lifetime |
| `WORKER_STALL_MS` | 60000 | No-log stall threshold |
| `WORKER_STALL_MS_QUIET` | 240000 | Stall threshold for quiet backends |
| `WORKER_STATE_DIR` | `~/.claude/workers` | State directory |
| `WORKER_SKIP_AUTH_GATE` | 0 | Skip auth probe (tests/ops) |
| `WORKER_GPG_MODE` | `agent` | GPG signing mode |

## Report CLI

```bash
bun run dist/report.js <handle>    # wait for worker, show result + diff
```

## Build

```bash
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
