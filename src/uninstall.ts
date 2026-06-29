import { unlinkSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function removeFromSettings(home: string) {
  const path = join(home, ".claude/settings.json");
  if (!existsSync(path)) return;

  const content = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (typeof content !== "object" || content === null) return;

  const settings = content as Record<string, unknown>;
  if (Array.isArray(settings.enabledMcpjsonServers)) {
    settings.enabledMcpjsonServers = settings.enabledMcpjsonServers.filter(
      (s) => s !== "worker"
    );
    writeFileSync(path, JSON.stringify(settings, null, 2));
  }
}

function removeFromClaudeConfig(home: string) {
  const path = join(home, ".claude.json");
  if (!existsSync(path)) return;

  const content = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (typeof content !== "object" || content === null) return;

  const config = content as Record<string, unknown>;
  const mcpServers = config.mcpServers;
  if (typeof mcpServers === "object" && mcpServers !== null) {
    const servers = mcpServers as Record<string, unknown>;
    delete servers["worker"];
    writeFileSync(path, JSON.stringify(config, null, 2));
  }
}

export function uninstall() {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME environment variable not set");

  const hooks = [
    join(home, ".claude/hooks/session-start/worker-lifecycle.sh"),
    join(home, ".claude/hooks/session-end/worker-session-end.sh"),
  ];

  for (const hook of hooks) {
    if (existsSync(hook)) unlinkSync(hook);
  }

  removeFromSettings(home);
  removeFromClaudeConfig(home);

  console.log("worker uninstalled successfully.");
}

if (import.meta.main) {
  uninstall();
}
