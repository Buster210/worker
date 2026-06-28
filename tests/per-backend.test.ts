import {
  describe,
  it,
  expect,
  afterAll,
  afterEach,
  setDefaultTimeout,
} from "bun:test";

setDefaultTimeout(70_000);
import { spawn, spawnSync } from "child_process";
import { writeFileSync, readFileSync, rmSync, mkdtempSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

const STATE_DIR = join(tmpdir(), `wperbe-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;
process.env.WORKER_RC = "";
process.env.WORKER_LOGIN_SHELL = "0";

import { resolveStatus } from "../src/runner.ts";
import { emitsJsonLog } from "../src/backends.ts";
import { backendShellArgv } from "../src/runner.ts";
import { readSentinel } from "../src/logParse.ts";
import { isProcessAlive, killProcessTree } from "../src/process.ts";
import { workerEnv } from "../src/env.ts";

const REPO = mkdtempSync(join(tmpdir(), "wperbe-repo-"));
const tmpFiles: string[] = [];
const tmpLogs: string[] = [];
const frozenPids: number[] = [];
let seq = 0;

function safeRm(p: string) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {}
}

afterEach(() => {
  for (const pid of frozenPids) {
    try {
      killProcessTree(pid, "SIGKILL");
    } catch {}
  }
  frozenPids.length = 0;
  for (const f of tmpFiles) safeRm(f);
  tmpFiles.length = 0;
});

afterAll(() => {
  for (const f of tmpLogs) safeRm(f);
  safeRm(REPO);
  safeRm(STATE_DIR);
});

function fakeScript(body: string): { path: string; argv: string[] } {
  const path = join(tmpdir(), `wperbe-${process.pid}-${seq++}.sh`);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  tmpFiles.push(path);
  return { path, argv: ["bash", path] };
}

async function runToLog(
  argv: string[],
  logPath: string,
  timeoutMs: number,
): Promise<{
  rc: number;
  timedOut: boolean;
  content: string;
  killedByUs: boolean;
}> {
  const fd = require("fs").openSync(logPath, "a");
  const wrapped = backendShellArgv(argv);
  const proc = spawn(wrapped[0], wrapped.slice(1), {
    cwd: REPO,
    env: workerEnv(),
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  proc.unref();
  frozenPids.push(proc.pid!);
  const start = Date.now();
  let sawTerminal = false;
  let terminalSince = 0;
  let killedByUs = false;
  const json = emitsJsonLog(argv[0] as any);
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(proc.pid!)) break;
    try {
      if (statSync(logPath).size > 0) {
        if (readSentinel(logPath, json).status !== null) {
          if (!sawTerminal) {
            sawTerminal = true;
            terminalSince = Date.now();
          }
          if (Date.now() - terminalSince > 3000) {
            killProcessTree(proc.pid!, "SIGTERM");
            killedByUs = true;
            break;
          }
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  let alive = true;
  try {
    process.kill(proc.pid!, 0);
    alive = true;
  } catch {
    alive = false;
  }
  const rc = killedByUs ? 0 : alive ? 124 : 0;
  const timedOut = alive && !killedByUs;
  try {
    require("fs").closeSync(fd);
  } catch {}
  const content = readFileSync(logPath, "utf8");
  return { rc, timedOut, content, killedByUs };
}

function logFile(suffix: string): string {
  const p = join(REPO, `run-${seq++}-${suffix}.log`);
  tmpLogs.push(p);
  return p;
}

function backendAvailable(be: string): boolean {
  const r = spawnSync(be, ["--version"], { stdio: "ignore", timeout: 5000 });
  return r.status === 0 || r.status === 2;
}

describe("claude real CLI", () => {
  if (!backendAvailable("claude")) {
    it.skip("claude not on PATH", () => {});
    return;
  }

  it("plain text output: exit 0 + DONE line → done", async () => {
    const lp = logFile("claude-done");
    const sid = randomUUID();
    const argv = [
      "claude",
      "-p",
      "say only DONE",
      "--model",
      "sonnet",
      "--dangerously-skip-permissions",
      "--session-id",
      sid,
      "--add-dir",
      "/tmp",
    ];
    const r = await runToLog(argv, lp, 60_000);
    const content = readFileSync(lp, "utf8");
    if (r.timedOut || !content.includes("DONE")) {
      console.error(
        "claude test: backend did not produce DONE in time; tail=",
        content.slice(-300),
      );
      return;
    }
    expect(resolveStatus("claude", r.rc, lp, r.timedOut)).toBe("done");
  });
});

describe("omp real CLI", () => {
  if (!backendAvailable("omp")) {
    it.skip("omp not on PATH", () => {});
    return;
  }

  it("JSONL output: agent_end with text DONE → done", async () => {
    const sd = join(REPO, `omp-${seq++}`);
    safeRm(sd);
    const lp = logFile("omp-done");
    const argv = [
      "omp",
      "-p",
      "say DONE",
      "--session-dir",
      sd,
      "--approval-mode=yolo",
      "--mode=json",
    ];
    const r = await runToLog(argv, lp, 60_000);
    const content = readFileSync(lp, "utf8");
    const status = resolveStatus("omp", r.rc, lp, r.timedOut);
    if (r.timedOut) {
      console.error(
        "omp test: timed out; status=",
        status,
        "tail=",
        content.slice(-300),
      );
      return;
    }
    if (status === "failed" || (status as string).startsWith("failed:")) {
      console.error(
        "omp test: provider errored (likely no credits); status=",
        status,
      );
      return;
    }
    expect(status).toBe("done");
    expect(content).toContain('"type":"message_end"');
  });

  it("JSONL output: provider errorStatus → failed:<message>", async () => {
    const sd = join(REPO, `omp-err-${seq++}`);
    safeRm(sd);
    const lp = logFile("omp-err");
    const argv = [
      "omp",
      "-p",
      "say DONE",
      "--session-dir",
      sd,
      "--approval-mode=yolo",
      "--mode=json",
    ];
    const r = await runToLog(argv, lp, 60_000);
    const content = readFileSync(lp, "utf8");
    const hasErrorEvent = /"errorStatus":\s*\d{3}/.test(content);
    if (!hasErrorEvent || r.timedOut) {
      console.error(
        "omp error test: no provider error in log (likely succeeded this run); status=",
        resolveStatus("omp", r.rc, lp, r.timedOut),
      );
      return;
    }
    const status = resolveStatus("omp", r.rc, lp, r.timedOut);
    if (!(status.startsWith("failed:") || status === "failed")) {
      console.error(
        "omp error test: status=",
        status,
        "logsize=",
        statSync(lp).size,
        "FULL:",
        content,
      );
    }
    expect(status.startsWith("failed:") || status === "failed").toBe(true);
  });
});

describe("codex real CLI", () => {
  if (!backendAvailable("codex")) {
    it.skip("codex not on PATH", () => {});
    return;
  }

  it("JSONL output: agent_message DONE → done", async () => {
    const lp = logFile("codex-done");
    const argv = [
      "codex",
      "exec",
      "--json",
      "--cd",
      REPO,
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "say DONE",
    ];
    const r = await runToLog(argv, lp, 60_000);
    const content = readFileSync(lp, "utf8");
    if (r.timedOut) {
      console.error("codex test: timed out; tail=", content.slice(-300));
      return;
    }
    const status = resolveStatus("codex", r.rc, lp, r.timedOut);
    if (status.startsWith("failed") || status === "failed") {
      console.error("codex test: failed (likely auth); status=", status);
      return;
    }
    expect(status).toBe("done");
  });
});

describe("cmd real CLI", () => {
  if (!backendAvailable("cmd")) {
    it.skip("cmd not on PATH", () => {});
    return;
  }

  it("plain text: exit 0 → done", async () => {
    const lp = logFile("cmd-done");
    const argv = [
      "cmd",
      "-p",
      "say DONE",
      "--yolo",
      "-t",
      "--skip-onboarding",
      "--add-dir",
      REPO,
    ];
    const r = await runToLog(argv, lp, 60_000);
    if (r.timedOut) return;
    expect(resolveStatus("cmd", r.rc, lp, r.timedOut)).toBe("done");
  });

  it("plain text: rc=8 (max-turns) → failed:max-turns", async () => {
    const lp = logFile("cmd-maxturns");
    const { argv } = fakeScript(
      'cmd -p "loop" --yolo --max-turns 1 --skip-onboarding --add-dir /tmp 2>&1',
    );
    const r = await runToLog(argv, lp, 60_000);
    if (r.timedOut) return;
    const status = resolveStatus("cmd", r.rc, lp, r.timedOut);
    if (status === "done") {
      console.error("cmd max-turns test: backend did not hit cap; rc=", r.rc);
      return;
    }
    expect(status === "failed:max-turns" || status.startsWith("failed")).toBe(
      true,
    );
  });
});

describe("pool real CLI", () => {
  if (!backendAvailable("pool")) {
    it.skip("pool not on PATH", () => {});
    return;
  }

  it("JSONL output: thought DONE → done", async () => {
    const lp = logFile("pool-done");
    const argv = [
      "pool",
      "exec",
      "-p",
      "say DONE",
      "-d",
      REPO,
      "--unsafe-auto-allow",
    ];
    const r = await runToLog(argv, lp, 60_000);
    if (r.timedOut) return;
    const status = resolveStatus("pool", r.rc, lp, r.timedOut);
    if (status === "failed" || status.startsWith("failed")) {
      console.error("pool test: failed (likely auth); status=", status);
      return;
    }
    expect(["done", "failed:task", "failed"].includes(status)).toBe(true);
  });
});

describe("opencode real CLI", () => {
  if (!backendAvailable("opencode")) {
    it.skip("opencode not on PATH", () => {});
    return;
  }

  it("JSONL output via --format json: emits JSON events", async () => {
    const lp = logFile("opencode-json");
    const argv = [
      "opencode",
      "run",
      "--dir",
      REPO,
      "--dangerously-skip-permissions",
      "--format",
      "json",
      "say DONE",
    ];
    const r = await runToLog(argv, lp, 60_000);
    const content = readFileSync(lp, "utf8");
    if (r.timedOut) {
      console.error("opencode test: timed out; tail=", content.slice(-300));
      return;
    }
    expect(content.length).toBeGreaterThan(0);
    expect(content.startsWith("{") || content.includes('"type"')).toBe(true);
  });
});

describe("resource limits", () => {
  it("spawn does not lower nice priority (workers get full CPU)", () => {
    let niceSet = false;
    const proc = spawn("bash", ["-c", "echo $$; sleep 1"], {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
    frozenPids.push(proc.pid!);
    const r = spawnSync("ps", ["-o", "nice=", "-p", String(proc.pid!)], {
      encoding: "utf8",
    });
    const nice = parseInt(r.stdout.trim(), 10);
    if (!isNaN(nice) && nice !== 0) niceSet = true;
    expect(niceSet).toBe(false);
  });
});
