# opencode — backend dialect

*Build-spec / debug reference for the executor (`src/server.ts`, the MCP server). Read to debug this backend or extend the wrapper — do not hand-assemble these flags per run. Verbs + JSON contract: the `worker-control` skill (`mcp__worker__*` tools).*

Inherits standards: **NO** (reads `opencode.json` / `AGENTS.md`).

- headless:     `opencode run "<spec>" --format json -m <prov/model> --dir <repo> --dangerously-skip-permissions`
- interactive:  `opencode <repo>`
- resume:       `-c` (last) · `-s <sessionID>`  — session id captured post-hoc
- model/effort: `-m <prov/model>` · `--variant high|max|minimal`
- auto-accept:  `run` auto-executes tools headless by default — no `opencode.json` pre-allow needed; `--dangerously-skip-permissions` (v1.16+, default false) overrides explicit denylists — include it on all headless invocations; config gate applies to interactive only
- inject:       prepend standards into `<spec>` (no `--append-system-prompt` on `run`), or `--agent <preconfigured>`
- output/done:  `--format json` (raw event stream) + exit 0
- handle/kill:  generated uuid (not in argv) → capture `worker_pid` at launch → `kill <worker_pid>`; `resume_token` = session id
