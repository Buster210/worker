#!/usr/bin/env bash
set -u
tokens="${STUB_TOKENS:-200}"
delay_ms="${STUB_DELAY_MS:-50}"
final="${STUB_FINAL:-DONE}"

emit() {
  printf '%s\n' "$1"
}

for i in $(seq 1 "$tokens"); do
  text="token-$i"
  msg=$(printf '{"message":{"role":"assistant","content":[{"type":"text","text":"%s"}]}}' "$text")
  emit "$msg"
  if [ "$delay_ms" -gt 0 ]; then
    sleep "$(awk -v ms="$delay_ms" 'BEGIN{printf "%.3f", ms/1000}')"
  fi
done

emit "{\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"$final\"}]}}"
exit 0