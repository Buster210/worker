# omp — backend dialect

*Build-spec / debug reference for the executor (`src/server.ts`, the MCP server). Read to debug this backend or extend the wrapper — do not hand-assemble these flags per run. Verbs + JSON contract: the `worker-control` skill (`mcp__worker__*` tools).*

Inherits standards: **NO** (wrapper prepends them via `buildSpec` STANDARDS preamble). Autonomous tool use by default (read/bash/edit/write) — fence with `--tools <allowlist>` / `--no-tools` in an untrusted repo.

- headless:     `omp -p '<spec>' --session-dir <jobdir>` (wrapper sets cwd=repo; no `--add-dir`)
- interactive:  `omp`
- resume:       `-c`/`--continue` resumes the latest session in `--session-dir` · `-r <id>` by id prefix. Wrapper pins a per-job `--session-dir = ~/.claude/workers/<project>/<handle>/` and resumes with `--continue`. NO pre-assignable session id (unlike old pi `--session-id`).
- model:        wrapper threads NONE (omp uses its own default). Manual: `--model <pat>` (fuzzy: `opus`, `gpt-5.2`) · `--provider <name>` (legacy) · `--thinking <minimal|low|medium|high|xhigh>` · `PI_*` env (`PI_SMOL_MODEL`/`PI_SLOW_MODEL`/`PI_PLAN_MODEL`).
- auto-accept:  autonomous by default (no perm flag)
- inject:       standards prepended into `<spec>` by `buildSpec` (or `--append-system-prompt '<text>'`)
- output/done:  text mode (default); `DONE`/`FAILED:<reason>` sentinel scanned from `run.log` tail. `--mode json` exists but the wrapper uses text.
- handle/kill:  short `w-` handle; pid captured at launch → process-group SIGKILL. Session is keyed by `--session-dir`, not an id.
