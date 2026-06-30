import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const SHARED_LIFECYCLE = `port_up() { nc -z -w 2 127.0.0.1 "$PORT" >/dev/null 2>&1; }
wait_for_port() {
  for i in $(seq 1 10); do
    sleep 1
    if port_up; then
      return 0
    fi
  done
  echo "[worker] WARNING: daemon did not bind port $PORT in 10s" >&2
  return 1
}
get_claude_pid() {
  local pid=$$ max_depth=10 depth=0 comm ppid
  while [ "$depth" -lt "$max_depth" ]; do
    comm=$(ps -o comm= -p "$pid" 2>/dev/null | tr -d ' ')
    case "$comm" in
      claude|claude-*|*/claude|*/claude-*) echo "$pid"; return 0 ;;
    esac
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -z "$ppid" ] || [ "$ppid" = "0" ] || [ "$ppid" = "1" ] && break
    pid=$ppid
    depth=$((depth + 1))
  done
  echo "$$"
}
liveness_reap() {
  local reaped=0 f name
  for f in "$ACTIVE_DIR"/*; do
    [ -f "$f" ] || continue
    name=\${f##*/}
    case $name in *[!0-9]*) continue;; esac
    if ! kill -0 "$name" 2>/dev/null; then
      rm -f "$f"
      reaped=$((reaped + 1))
    fi
  done
}
liveness_register() { touch "$ACTIVE_DIR/$(get_claude_pid)"; }
liveness_unregister() { rm -f "$ACTIVE_DIR/$(get_claude_pid)"; }
liveness_count() {
  liveness_reap
  local n=0 f name
  for f in "$ACTIVE_DIR"/*; do
    [ -f "$f" ] || continue
    name=\${f##*/}
    case "$name" in server.pid|daemon.pid|.lock|.lockd|.*|*.pid) continue ;; esac
    case $name in *[!0-9]*) continue;; esac
    n=$((n + 1))
  done
  echo "$n"
}
get_server_pid() { lsof -ti:"$PORT" 2>/dev/null | head -1; }
save_server_pid() {
  local pid
  pid=$(get_server_pid)
  [ -n "$pid" ] && echo "$pid" > "$ACTIVE_DIR/server.pid"
}
read_server_pid() { cat "$ACTIVE_DIR/server.pid" 2>/dev/null || true; }
kill_server() {
  local pid port_pid
  pid=$(read_server_pid)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    /bin/kill -TERM "$pid" 2>/dev/null || true
    for _ in 1 2 3; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$pid" 2>/dev/null && /bin/kill -9 "$pid" 2>/dev/null || true
  else
    port_pid=$(lsof -ti:"$PORT" 2>/dev/null | head -1)
    [ -n "$port_pid" ] && /bin/kill -TERM "$port_pid" 2>/dev/null || true
  fi
  rm -f "$ACTIVE_DIR/server.pid" "$ACTIVE_DIR/daemon.pid"
}
health_ok() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 "http://127.0.0.1:\${PORT}\${HEALTH_PATH}" 2>/dev/null || true)
  [ "\${code:-0}" -gt 0 ] 2>/dev/null
}
acquire_daemon_lock() {
  local lock_dir="$ACTIVE_DIR/.lock"
  if ! mkdir "$lock_dir" 2>/dev/null; then
    local lpid
    lpid=$(cat "$lock_dir/pid" 2>/dev/null)
    if [ -n "$lpid" ] && kill -0 "$lpid" 2>/dev/null; then
      return 1
    fi
    rm -rf "$lock_dir" && mkdir "$lock_dir" 2>/dev/null || return 1
  fi
  echo $$ > "$lock_dir/pid"
  trap 'rm -rf "'"$lock_dir"'"' EXIT
}
`;

const START_HOOK = (runtime: string, serverJs: string, installPort: string) => `#!/usr/bin/env bash
set -uo pipefail

[ -z "\${CLAUDE_PROJECT_DIR:-}" ] && exit 0

ACTIVE_DIR="$HOME/.claude/.active/worker"
PORT="\${WORKER_PORT:-${installPort}}"
export WORKER_PORT="$PORT"
HEALTH_PATH="/health"
RUNTIME=${shQuote(runtime)}
SERVER_JS=${shQuote(serverJs)}
${SHARED_LIFECYCLE}
daemon_session_start() {
  local active_dir="$1" port="$2" runtime="$3" server_js="$4"
  shift 4

  ACTIVE_DIR="$active_dir"
  PORT="$port"
  mkdir -p "$ACTIVE_DIR"

  liveness_register

  if port_up; then
    if health_ok; then
      save_server_pid
      exit 0
    fi
    kill_server
    sleep 1
  fi

  acquire_daemon_lock || exit 0
  if port_up; then
    if health_ok; then
      save_server_pid
      exit 0
    fi
    kill_server
    sleep 1
  fi

  command -v "$runtime" >/dev/null 2>&1 || exit 0
  nohup "$runtime" "$server_js" > /dev/null 2>&1 &
  disown $!
  wait_for_port || true
  save_server_pid
}
daemon_session_start "$ACTIVE_DIR" "$PORT" "$RUNTIME" "$SERVER_JS"
`;

const END_HOOK = (installPort: string) => `#!/usr/bin/env bash
set -uo pipefail

ACTIVE_DIR="$HOME/.claude/.active/worker"
PORT="\${WORKER_PORT:-${installPort}}"
${SHARED_LIFECYCLE}
daemon_session_end() {
  ACTIVE_DIR="$1"
  PORT="$2"
  liveness_unregister
  local remaining
  remaining=$(liveness_count)
  [ "$remaining" -eq 0 ] || return 0
  sleep 5
  remaining=$(liveness_count)
  [ "$remaining" -eq 0 ] || return 0
  kill_server
}
daemon_session_end "$ACTIVE_DIR" "$PORT"
`;

export function install() {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME env var not set');
  // WORKER_PORT is interpolated unquoted into the generated shell hooks and the MCP
  // url; force it to a valid numeric port so a hostile value can't inject shell.
  // ponytail: numeric coercion at the source covers all interpolation sites at once.
  const portNum = Number(process.env.WORKER_PORT);
  const installPort = String(
    Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535 ? portNum : 54321,
  );
  const serverJs = fileURLToPath(new URL('../dist/server.js', import.meta.url));
  const runtime = process.execPath;

  const startDir = join(home, '.claude', 'hooks', 'session-start');
  const endDir = join(home, '.claude', 'hooks', 'session-end');
  mkdirSync(startDir, { recursive: true });
  mkdirSync(endDir, { recursive: true });

  const startPath = join(startDir, 'worker-lifecycle.sh');
  const endPath = join(endDir, 'worker-session-end.sh');
  writeFileSync(startPath, START_HOOK(runtime, serverJs, installPort));
  writeFileSync(endPath, END_HOOK(installPort));

  chmodSync(startPath, 0o755);
  chmodSync(endPath, 0o755);

  const settingsPath = join(home, '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as unknown as Record<string, unknown>;
    const enabledServers = Array.isArray(settings.enabledMcpjsonServers) ? settings.enabledMcpjsonServers : [];
    if (!enabledServers.includes('worker')) {
      enabledServers.push('worker');
      settings.enabledMcpjsonServers = enabledServers;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
  }

  const claudeJsonPath = join(home, '.claude.json');
  if (existsSync(claudeJsonPath)) {
    const config = JSON.parse(readFileSync(claudeJsonPath, 'utf-8')) as unknown as Record<string, unknown>;
    const mcpServers = (config.mcpServers || {}) as Record<string, unknown>;
    if (!mcpServers.worker) {
      mcpServers.worker = { type: 'http', url: `http://127.0.0.1:${installPort}/mcp` };
      config.mcpServers = mcpServers;
      writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
    }
  }

  console.log('Worker installed successfully.');
}

if (import.meta.main) {
  install();
}
