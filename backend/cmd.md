# cmd — backend dialect (Command Code)

*Build-spec / debug reference for the executor (`src/server.ts`, the MCP server). Read to debug this backend or extend the wrapper — do not hand-assemble these flags per run. Verbs + JSON contract: the `worker-control` skill (`mcp__worker__*` tools).*

Inherits standards: **NO** (own "taste" system). `--skip-onboarding` for automated runs.

- headless:     `cmd -p '<spec>' --yolo --skip-onboarding --add-dir <repo>`  (`--auto-accept` alone still blocks writes headless ⚠️ — verified)
- interactive:  `cmd --add-dir <repo>`  (or: `cmd "<message>"`)
- resume:       headless `-p` is SINGLE-SHOT — `-c`/`-r` do NOT resume a `-p` run (verified: replies "no previous context"). Fix-loop = re-invoke `-p` with the fix inlined (repo + `git diff` ARE the state). `-c`/`-r` resume INTERACTIVE sessions only.
- model:        `--model` · `--max-turns <n>` (default 10; exit 8 on cap)
- auto-accept:  headless writes need `--yolo` (or `--dangerously-skip-permissions`); `--auto-accept`/`--permission-mode auto-accept` do NOT bypass the write gate in `-p` mode
- inject:       prepend standards into `<spec>` (no `--append-system-prompt`)
- output/done:  none (text only) → exit 0 = done, exit 8 = max-turns cap; lean on exit code + git diff
- handle/kill:  generated uuid (not in argv) → capture `worker_pid` at launch → `kill <worker_pid>` (verified); `resume_token` = n/a headless (no resume — re-invoke with inlined fix)
