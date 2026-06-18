#!/usr/bin/env bash
# Reuse-path probe stub. Behaves by what it finds in cwd (the worktree):
#   rung 1 (no .attempt marker) -> drop the marker, then go silent past the stall window -> killed as `stalled`
#   rung 2 (marker present) -> only possible if the SAME worktree was reused -> emit DONE + write result.txt
# So a final `done` PROVES the retry rung ran in rung 1's worktree (work carried, no fresh tree).
set -u

# spec = arg right after -p (lets us assert the continuation preamble reached rung 2)
spec=""; prev=""
for a in "$@"; do [ "$prev" = "-p" ] && spec="$a"; prev="$a"; done

if [ -f .attempt ]; then
  printf '%s' "$spec" > .spec-rung2
  printf '{"message":{"role":"assistant","content":[{"type":"text","text":"resuming prior work"}]}}\n'
  sleep 0.3
  printf '{"message":{"role":"assistant","content":[{"type":"text","text":"DONE"}]}}\n'
  echo "carried result" > result.txt
  exit 0
else
  echo "rung1 was here" > .attempt
  sleep 30   # silent past WORKER_STALL_MS -> watchdog marks stalled and SIGKILLs
  exit 0
fi
