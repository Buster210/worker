# pi — backend dialect

*Build-spec / debug reference for the executor (`src/server.ts`, the MCP server). Read to debug this backend or extend the wrapper — do not hand-assemble these flags per run. Verbs + JSON contract: the `worker-control` skill (`mcp__worker__*` tools).*

Inherits standards: **NO**. Autonomous tool use by default (read/bash/edit/write) — no stall; fence with `--tools <allowlist>` / `--exclude-tools` in an untrusted repo.

- headless:     `pi -p '<spec>' --session-id "$SID" --mode json`
- interactive:  `pi`
- resume:       `--resume`/`-r` · `-c` · or `--session-id "$SID"` (pre-assignable)
- model:        `--model <pat>` · `--provider <name>` (default google) · `--thinking <off|minimal|low|medium|high|xhigh>`
- auto-accept:  autonomous by default (no perm flag)
- inject:       `--append-system-prompt '<standards>'`
- output/done:  `--mode json` + exit 0
- handle/kill:  `$SID` (pre-assignable, in argv) → `pkill -f "$SID"`; `resume_token == handle`
