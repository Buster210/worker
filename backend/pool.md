# pool — backend dialect (Poolside, ACP)

*Build-spec / debug reference for the executor (`src/server.ts`, the MCP server). Read to debug this backend or extend the wrapper — do not hand-assemble these flags per run. Verbs + JSON contract: the `worker-control` skill (`mcp__worker__*` tools).*

Inherits standards: **NO** (`~/.config/poolside/settings.yaml`). Prereq: `pool login`.

- headless:     `pool exec -p "<spec>" --directory <repo> -o json --unsafe-auto-allow`
- interactive:  `pool`  /  `pool acp`
- resume:       `--continue` alone resumes the LAST conversation (verified — put it last so no value gets swallowed) · `--continue <RunID>` for a specific run
- model:        `-m`/`--model` is OBSOLETE ⚠️ (runtime rejects → "use --agent-name (-a)"). `-a`/`--agent-name` on `exec` = tenant-mode only. Verified path: config default (`pool.json` `agent_servers` / `/model`); `-s`/`--agent-server` picks the server.
- auto-accept:  `--unsafe-auto-allow` (+ `--sandbox required|disabled`)
- inject:       prepend standards into `<spec>`
- output/done:  `-o json` (NLJSON, 1 obj/line); EXIT 0 success · 4 task-fail · other = error (cleanest signal)
- handle/kill:  generated uuid (not in argv) → capture `worker_pid` at launch → `kill <worker_pid>` (verified); `resume_token` = RunID (optional — `--continue` alone resumes last)
