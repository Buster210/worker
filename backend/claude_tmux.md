# claude_tmux — backend dialect

*Build-spec / debug reference for the executor (`src/server.ts` + `runClaudeTmux` in `src/runner.ts`). Read to debug this backend or extend the wrapper — do not hand-assemble these flags per run. Verbs + JSON contract: the `mcp__worker__*` tools.*

**Why it exists:** from 2026-06-15 headless `claude -p` is no longer covered by the Claude subscription, but the *interactive* TUI still is. This backend drives interactive `claude` inside a detached tmux session so claude keeps working as a worker on a subscription (the headless `claude` backend stays for API-key users). It is the last rung of the ladder.

Inherits `~/.claude` standards: **YES** (launched in the repo, reads its `CLAUDE.md`).

- launch:       detached tmux session running `claude --settings <f> --dangerously-skip-permissions --model sonnet "$(cat <specfile>)"`
- model:        pinned **sonnet** (not overridable)
- trust:        interactive claude blocks on the workspace trust dialog in an untrusted repo (no flag bypasses it — gated before settings, hardened by CVE-2026-33068). `seedRepoTrust()` pre-seeds `~/.claude.json` (raw + realpath keys), **atomically** (tmp+rename), **backed up once** to `~/.claude.json.worker-bak`, skipped if already trusted, and **never restored** (the flag is benign/idempotent; restoring would clobber concurrent claude writes)
- done signal:  a `Stop` hook (injected via `--settings`) appends to a `<sid>.done` sentinel file, polled until non-empty; also exits if the tmux session vanishes
- log:          TUI has no clean stdout, so `tmux capture-pane -p -S -5000` is captured to `run.log` at teardown; `resolveStatus` scans it for `DONE` / `FAILED:<reason>`
- timeout:      sentinel never fires before the deadline → `timeout` (exit 124)
- resume:       **none** (`resume_token` is empty; not resumable)
- handle/kill:  `$handle` is the tmux session name → `tmux kill-session -t <handle>`
- requires:     `tmux` on PATH (run fails fast if absent)
