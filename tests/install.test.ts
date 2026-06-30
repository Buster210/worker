import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { install } from "../src/install.ts";
import { uninstall } from "../src/uninstall.ts";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ENV_KEYS = ["HOME", "WORKER_PORT"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let home = "";

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  home = mkdtempSync(join(tmpdir(), "worker-install-"));
  process.env.HOME = home;
  process.env.WORKER_PORT = "54399";
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ enabledMcpjsonServers: ["other"] }, null, 2),
  );
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { other: { type: "http", url: "http://127.0.0.1:1/mcp" } } }, null, 2),
  );
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("install/uninstall", () => {
  it("writes self-contained hooks and removes them again", () => {
    install();

    const startPath = join(home, ".claude", "hooks", "session-start", "worker-lifecycle.sh");
    const endPath = join(home, ".claude", "hooks", "session-end", "worker-session-end.sh");
    const startHook = readFileSync(startPath, "utf8");
    const endHook = readFileSync(endPath, "utf8");

    expect(startHook).not.toContain("daemon-lifecycle.sh");
    expect(startHook).not.toContain("log.sh");
    expect(endHook).not.toContain("daemon-lifecycle.sh");
    expect(endHook).not.toContain("log.sh");
    expect(startHook).toContain(process.execPath);
    expect(startHook).toContain(join(process.cwd(), "dist", "server.js"));
    expect(startHook).toContain('PORT="${WORKER_PORT:-54399}"');
    expect(endHook).toContain('PORT="${WORKER_PORT:-54399}"');

    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as {
      enabledMcpjsonServers?: string[];
    };
    expect(settings.enabledMcpjsonServers).toContain("worker");

    const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
      mcpServers?: Record<string, { type: string; url: string }>;
    };
    expect(claude.mcpServers?.worker?.url).toBe("http://127.0.0.1:54399/mcp");

    uninstall();

    expect(existsSync(startPath)).toBe(false);
    expect(existsSync(endPath)).toBe(false);
    expect(existsSync(join(home, ".claude", "hooks", "session-start"))).toBe(false);
    expect(existsSync(join(home, ".claude", "hooks", "session-end"))).toBe(false);
    expect(existsSync(join(home, ".claude", "hooks"))).toBe(false);

    const afterSettings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as {
      enabledMcpjsonServers?: string[];
    };
    expect(afterSettings.enabledMcpjsonServers).toEqual(["other"]);

    const afterClaude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
      mcpServers?: Record<string, { type: string; url: string }>;
    };
    expect(afterClaude.mcpServers?.worker).toBeUndefined();
    expect(afterClaude.mcpServers?.other).toBeDefined();
  });
});
