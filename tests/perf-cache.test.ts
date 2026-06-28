import { describe, it, expect, afterAll, spyOn } from "bun:test";
import * as childProcess from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";

const STATE_DIR = join(tmpdir(), `wperf-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;
process.env.WORKER_LOGIN_SHELL = "0";
process.env.WORKER_RC = "";

import { assertRepo } from "../src/lifecycle.ts";
import { isProcessAlive } from "../src/process.ts";
import {
  loginShellEnv,
  loginEnvSig,
  loginEnvCachePath,
  __resetLoginEnvCache,
} from "../src/env.ts";

afterAll(() => {
  try {
    rmSync(STATE_DIR, { recursive: true, force: true });
  } catch {}
});

describe("perf cache seams", () => {
  it("caches repo assertions per directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "wperf-repo-"));
    const initResult = childProcess.spawnSync("git", ["init", "-q"], {
      cwd: dir,
      stdio: "ignore",
    });
    expect(initResult.status).toBe(0);

    const spy = spyOn(childProcess, "spawnSync");
    try {
      assertRepo(dir);
      assertRepo(dir);

      const gitChecks = spy.mock.calls.filter(
        ([cmd, args]) =>
          cmd === "git" &&
          Array.isArray(args) &&
          args[0] === "rev-parse" &&
          args[1] === "--is-inside-work-tree",
      );
      expect(gitChecks).toHaveLength(1);
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips ps when liveness is checked without a start time", () => {
    const mockSpawnSync = ((cmd: string) => {
      if (cmd === "ps") {
        return { status: 0, stdout: "00:01", stderr: "" };
      }
      throw new Error(`unexpected spawnSync call: ${cmd}`);
    }) as typeof childProcess.spawnSync;
    const spy = spyOn(childProcess, "spawnSync").mockImplementation(
      mockSpawnSync,
    );

    try {
      expect(isProcessAlive(process.pid)).toBe(true);
      expect(spy.mock.calls.filter(([cmd]) => cmd === "ps")).toHaveLength(0);

      expect(isProcessAlive(process.pid, new Date().toISOString())).toBe(true);
      expect(spy.mock.calls.filter(([cmd]) => cmd === "ps")).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("uses the login-env disk cache and respawns on stale signature", () => {
    const shell = process.env.SHELL ?? "/bin/zsh";
    const cachePath = loginEnvCachePath();
    mkdirSync(dirname(cachePath), { recursive: true });
    const prevLoginShell = process.env.WORKER_LOGIN_SHELL;

    const mockSpawnSync = ((cmd: string) => {
      if (cmd === shell) {
        return {
          status: 0,
          stdout: `__WORKER_ENV_a7f3__\n${JSON.stringify({ PATH: "/x", FOO: "bar" })}`,
          stderr: "",
        };
      }
      throw new Error(`unexpected spawnSync call: ${cmd}`);
    }) as typeof childProcess.spawnSync;
    const spy = spyOn(childProcess, "spawnSync").mockImplementation(
      mockSpawnSync,
    );

    try {
      process.env.WORKER_LOGIN_SHELL = "1";

      writeFileSync(
        cachePath,
        JSON.stringify({
          shell,
          sig: loginEnvSig(shell),
          env: { FOO: "cached" },
        }),
      );
      __resetLoginEnvCache();

      const cachedEnv = loginShellEnv();
      expect(cachedEnv?.FOO).toBe("cached");
      expect(spy.mock.calls.filter(([cmd]) => cmd === shell)).toHaveLength(0);

      writeFileSync(
        cachePath,
        JSON.stringify({ shell, sig: "STALE", env: { FOO: "cached" } }),
      );
      __resetLoginEnvCache();

      const refreshedEnv = loginShellEnv();
      expect(refreshedEnv?.FOO).toBe("bar");
      expect(spy.mock.calls.filter(([cmd]) => cmd === shell)).toHaveLength(1);
    } finally {
      spy.mockRestore();
      if (prevLoginShell === undefined) delete process.env.WORKER_LOGIN_SHELL;
      else process.env.WORKER_LOGIN_SHELL = prevLoginShell;
      try {
        rmSync(cachePath, { force: true });
      } catch {}
    }
  });
});
