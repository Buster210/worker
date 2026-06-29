import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const LIFECYCLE_HOOK = `#!/usr/bin/env bash
set -uo pipefail

# shellcheck source=hooks/lib/daemon-lifecycle.sh
source "\${HOME}/.claude/hooks/lib/daemon-lifecycle.sh"

[ -z "\${CLAUDE_PROJECT_DIR:-}" ] && exit 0

PORT="\${WORKER_PORT:-54321}"
HEALTH_PATH="/health"
daemon_session_start "$HOME/.claude/.active/worker" "$PORT" worker
`;

const SESSION_END_HOOK = `#!/usr/bin/env bash
set -uo pipefail

# shellcheck source=hooks/lib/daemon-lifecycle.sh
source "\${HOME}/.claude/hooks/lib/daemon-lifecycle.sh"
daemon_session_end "$HOME/.claude/.active/worker" "\${WORKER_PORT:-54321}"
`;

function main() {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME env var not set');

  const startDir = join(home, '.claude', 'hooks', 'session-start');
  const endDir = join(home, '.claude', 'hooks', 'session-end');
  mkdirSync(startDir, { recursive: true });
  mkdirSync(endDir, { recursive: true });

  const startPath = join(startDir, 'worker-lifecycle.sh');
  const endPath = join(endDir, 'worker-session-end.sh');
  writeFileSync(startPath, LIFECYCLE_HOOK);
  writeFileSync(endPath, SESSION_END_HOOK);

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
      mcpServers.worker = { type: 'http', url: 'http://127.0.0.1:54321/mcp' };
      config.mcpServers = mcpServers;
      writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
    }
  }

  console.log('Worker installed successfully.');
}

if (import.meta.main) {
  main();
}
