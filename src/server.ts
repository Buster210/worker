import { basename, join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";
import { randomUUID } from "crypto";
import { existsSync, appendFileSync, statSync, renameSync } from "fs";
import http from "http";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  getJob,
  updateJob,
  finalizeJob,
  getAllJobs,
  getAllRunningJobs,
  readSpec,
  loadChainMeta,
  saveChainMeta,
  pruneTranscript,
  getLadderHistory,
  workersDir,
  stashSummary,
} from "./state.ts";
import { LADDER, ALL_BACKENDS, type Backend } from "./backends.ts";
import { backendShellArgv } from "./runner.ts";
import { workerEnv } from "./env.ts";
import { resolveStatus } from "./runner.ts";
import { isProcessAlive, spawnAsync } from "./process.ts";
import {
  sweepStaleJobs,
  reapStoppedJobs,
  sweepChainLocks,
  sweepStaleWorkerDirs,
} from "./maintenance.ts";
import {
  launch,
  forceKillJob,
  assertRepo,
  resumeLaunch as lifecycleResumeLaunch,
  spawnReaper,
} from "./lifecycle.ts";
import { handleLadder } from "./chain.ts";
import { terminalStatus } from "./jobStatus.ts";
import {
  acquireLock,
  readLock,
  removeLock,
  isDaemonAlive,
  SessionTracker,
  hardShutdown,
  writeServerPid,
  removeServerPid,
  checkClientLiveness,
} from "./daemon.ts";

export function reply(r: unknown) {
  const text = typeof r === "string" ? r : JSON.stringify(r);
  return { content: [{ type: "text" as const, text }] };
}

export function handleRun(
  args: {
    backend: Backend;
    specFile: string;
    model?: string;
    dir: string;
    timeout?: number;
    extraArgs?: string[];
  },
  mcpSid: string = randomUUID(),
): { handle: string; status: string; workdir: string } {
  assertRepo(args.dir);
  const prompt = readSpec(args.specFile);
  const { handle, promise, workdir } = launch(args.backend, prompt, args.dir, {
    mcpSid,
    model: args.model,
    extraArgs: args.extraArgs,
    timeoutMs: args.timeout ? args.timeout * 1000 : undefined,
    specFile: args.specFile,
  });
  void promise.catch(() => {});
  return { handle, status: "running", workdir };
}

export function handleResume(args: {
  handle: string;
  specFile: string;
  dir: string;
  timeout?: number;
  extraArgs?: string[];
}): { handle: string; status: string; workdir: string } {
  const prompt = readSpec(args.specFile);
  const { handle, promise, workdir } = lifecycleResumeLaunch({
    handle: args.handle,
    prompt,
    dir: args.dir,
    timeout: args.timeout,
    extraArgs: args.extraArgs,
    specFile: args.specFile,
  });
  void promise.catch(() => {});
  return { handle, status: "running", workdir };
}

export function handleKill(args: { handle: string }): string {
  const { handle } = args;
  const job = getJob(handle);
  if (!job) throw new Error(`No job found: ${handle}`);
  const TERMINAL = /^(done|failed|timeout|killed)/;
  if (TERMINAL.test(job.status)) {
    return `already ${job.status}`;
  }
  updateJob(handle, { kill_requested: true });
  const finalizeKilled = () =>
    finalizeJob(handle, resolveStatus(job.backend, 0, job.log_path, false));
  if (job.status === "stopped" && job.worker_pid) {
    forceKillJob(job);
    return `killed: ${handle} (${finalizeKilled()})`;
  }
  if (job.worker_pid) {
    try {
      process.kill(-job.worker_pid, "SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-job.worker_pid, "SIGKILL");
      } catch {}
    }, 3_000).unref?.();
  }
  if (!isProcessAlive(job.worker_pid, job.started)) {
    return `killed: ${handle} (${finalizeKilled()})`;
  }
  return `killed: ${handle}`;
}

export function handleStatus(args: {
  handle: string;
}): Record<string, unknown> {
  const { handle } = args;
  const job = getJob(handle);
  if (!job) throw new Error(`No job found: ${handle}`);
  // A chain handle is shared across all rungs — its job.json reflects the active or terminal rung.
  // Mirror worker-report: while the chain lock exists the chain is running; once it is gone, report the
  // chain's terminal status so worker_status and worker-report agree.
  const cl = job.completion_lock ?? "";
  if (cl.endsWith(".chain.lock")) {
    const running = existsSync(cl);
    if (running) {
      const result: Record<string, unknown> = {
        status: "running",
        alive: true,
        started: job.started,
      };
      const stash = stashSummary(job);
      if (stash) result.stash = stash;
      return result;
    }
    const status = terminalStatus(handle, cl);
    const result: Record<string, unknown> = {
      status,
      alive: false,
      started: job.started,
    };
    if (status === "exhausted") {
      const sid = basename(cl).replace(/\.chain\.lock$/, "");
      result.rungs = getLadderHistory(sid);
    }
    const stash = stashSummary(job);
    if (stash) result.stash = stash;
    return result;
  }
  let alive = false;
  if (
    job.worker_pid &&
    (job.status === "running" || job.status === "stopped")
  ) {
    alive = isProcessAlive(job.worker_pid, job.started);
  }
  const result: Record<string, unknown> = { status: job.status, alive, started: job.started };
  const stash = stashSummary(job);
  if (stash) result.stash = stash;
  return result;
}

export async function handleDoctor(args: {
  backend?: string;
}): Promise<string> {
  const backends = args.backend ? [args.backend] : [...ALL_BACKENDS];
  const probes = await Promise.all(
    backends.map(async (be) => {
      const [cmd, ...probeArgs] = backendShellArgv([be, "--version"]);
      const r = await spawnAsync(cmd, probeArgs, {
        env: workerEnv(),
        timeoutMs: 10_000,
        discardOutput: true,
      });
      return { be, down: r.status !== 0 || r.error != null };
    }),
  );
  const down = probes.filter((p) => p.down).map((p) => p.be);
  return down.length === 0
    ? "All workers operational."
    : `Not operational: ${down.join(", ")}`;
}

export function handleList(args: {
  status?: string;
  limit?: number;
}): Record<string, unknown>[] {
  const { status, limit = 20 } = args;
  return getAllJobs()
    .filter((j) => !status || j.status === status)
    .sort((a, b) => (b.started ?? "").localeCompare(a.started ?? ""))
    .slice(0, limit)
    .map((j) => ({
      handle: j.handle,
      status: j.status,
      repo: j.repo,
      task: j.task,
      started: j.started,
      ...(stashSummary(j) ? { stash: stashSummary(j) } : {}),
    }));
}

export function handleExtend(args: { handle: string; seconds: number }): {
  handle: string;
  deadline_at: number;
} {
  const { handle, seconds } = args;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) {
    throw new Error("seconds must be an integer between 1 and 86400");
  }
  const job = getJob(handle);
  if (!job) throw new Error(`No job found: ${handle}`);

  const now = Date.now();

  // A chain handle carries the chain completion_lock (`...ladder/<sid>.chain.lock`). For these the
  // extend is chain-WIDE: bump the .chain.meta deadline that runLadderChain + future rung launches
  // read. The handle itself may already be a finished rung (it climbed on), so DON'T require it to
  // be running — the running-only guard is only for plain per-job extends.
  const completionLock = job.completion_lock ?? "";
  const isChainHandle = completionLock.endsWith(".chain.lock");

  if (isChainHandle) {
    const filename = completionLock.split("/").pop() ?? "";
    const sid = filename.replace(".chain.lock", "");
    const chainMeta = sid ? loadChainMeta(sid) : null;
    if (!chainMeta)
      throw new Error(`Chain ${handle} has no active deadline to extend`);
    const newChainDeadline =
      Math.max(chainMeta.deadlineAt, now) + seconds * 1000;
    saveChainMeta(sid, { deadlineAt: newChainDeadline });
    if (job.status === "running")
      updateJob(handle, { deadline_at: newChainDeadline });
    return { handle, deadline_at: newChainDeadline };
  }

  if (job.status !== "running")
    throw new Error(`Job ${handle} is not running (status: ${job.status})`);
  const newDeadline = Math.max(job.deadline_at ?? 0, now) + seconds * 1000;
  updateJob(handle, { deadline_at: newDeadline });
  return { handle, deadline_at: newDeadline };
}

const WORKER_INSTRUCTIONS = `# worker — delegate coding task to bg agent

1 call = 1 worker. Active → repo working tree; concurrent → own worktree \`worker/<handle>\` off HEAD.

## Rules
- \`worker_ladder\` = DEFAULT. \`worker_run\` only when user names a backend. Params → tool schemas (not repeated here).
- Spec = TARGET: goal/outcome/criteria, NOT files/lines. Worker explores + decides. Give constraints + how-to-verify; leave the how.
- N workers parallel: idle → working tree, active → worktree. New call never kills existing. Cross-process safe.
- Done = ONE commit, no push, no merge — on \`worker/<handle>\` or current branch. \`worker-report <handle>\` = source of truth (diff vs pre-work base). Plain \`git diff\` empty post-commit → use \`git -C <path> show\` or \`diff <base_sha>\`.

## Run loop
1. \`worker_ladder(specFile, dir, timeout?)\` → \`{handle, status:"running"}\`. Returns now; worker runs in bg.
2. Per handle, run \`worker-report <handle>\` in its OWN bg process (Claude Code: Bash run_in_background:true). 1 report = 1 handle, never many. It blocks till that worker ends → bg report = you get notified per worker, main loop stays free. N workers → N bg reports. No sleep-poll, no foreground-block.
3. Report = completion + result in one. Status: completed · failed[:reason] · timeout · stopped · exhausted · killed · stalled. completed/failed/timeout/exhausted/stalled → path + branch + diff; stopped/killed → status only. Near deadline → NEAR_TIMEOUT (decide): \`worker_extend(handle, secs)\` then re-report, or \`worker-report <handle> --wait\` to block to final.
4. Then: completed → review + \`worker_cleanup\`. failed/timeout → inspect + \`worker_resume\`. stopped → \`worker_resume(handle, specFile, dir)\`. exhausted → all backends failed. stalled → chain self-heals. killed → stop.

Other tools self-describe: \`worker_extend\` \`worker_resume\` \`worker_kill\` \`worker_status\` \`worker_list\` \`worker_doctor\` \`worker_cleanup\`.`;

export function createWorkerServer(): McpServer {
  const s = new McpServer(
    { name: "worker", version: "0.3.0" },
    { instructions: WORKER_INSTRUCTIONS },
  );

  const bareFilename = (v: string) =>
    !v.includes("/") &&
    !v.includes("\\") &&
    v !== "." &&
    v !== ".." &&
    !v.includes("..");
  // Trim at the entry boundary so the SAME normalized name flows through the whole lifecycle:
  // readSpec reads it, the job stores it, archiveSpec moves it — all agree. Without this, a padded
  // 'plan.md ' reads fine (readSpec trims) but archives as a no-op (rename of the un-trimmed name misses).
  const specFileSchema = z
    .string()
    .min(1)
    .transform((v) => v.trim())
    .refine(
      (v) => v.length > 0 && bareFilename(v),
      "bare filename only (no path separators or ..)",
    )
    .describe("Spec filename (bare, no slashes) from ~/.claude/plans/");

  s.registerTool(
    "worker_ladder",
    {
      description: `Default lane. Run task on bg agent, climbs backend ladder. → {handle, status:'running'} on worker/<handle> or current branch. Spec + report loop → server instructions.`,
      inputSchema: {
        specFile: specFileSchema,
        dir: z
          .string()
          .min(1)
          .refine((v) => v.startsWith("/"), "absolute path required")
          .describe("Repo directory (absolute path, required)"),
        timeout: z
          .number()
          .int()
          .min(1)
          .max(3600)
          .optional()
          .describe("Hard timeout seconds (1..3600, default 600)"),
        complex: z
          .boolean()
          .optional()
          .describe(
            "true=hard; server picks model. Never pass model yourself.",
          ),
      },
    },
    async ({ specFile, dir, timeout, complex }, extra) => {
      const mcpSid =
        (extra.sessionId as string | undefined) ||
        process.env.CLAUDE_CODE_SESSION_ID ||
        randomUUID();
      const prompt = readSpec(specFile);
      return reply(
        handleLadder({ mcpSid, prompt, dir, timeout, complex, specFile }),
      );
    },
  );

  s.registerTool(
    "worker_run",
    {
      description: `Run task on a named backend — use only when user names one, else worker_ladder. → {handle, status:'running'}. Report loop → server instructions.`,
      inputSchema: {
        backend: z.string().describe("Named backend to run."),
        specFile: specFileSchema,
        model: z
          .string()
          .regex(/^[A-Za-z9._:-]+$/)
          .optional()
          .describe(
            "Model override. Ignored by workers that pin their own model.",
          ),
        dir: z
          .string()
          .min(1)
          .refine((v) => v.startsWith("/"), "absolute path required")
          .describe("Repo directory (absolute path, required)"),
        timeout: z
          .number()
          .int()
          .min(1)
          .max(3600)
          .optional()
          .describe("Hard timeout seconds (1..3600, default 600)"),
        extraArgs: z
          .array(z.string().max(4096))
          .optional()
          .describe("Raw worker CLI args."),
      },
    },
    async ({ backend, ...rest }, extra) => {
      const mcpSid =
        (extra.sessionId as string | undefined) ||
        process.env.CLAUDE_CODE_SESSION_ID ||
        randomUUID();
      if (!LADDER.includes(backend as Backend))
        return reply(`Unknown worker: ${backend}`);
      return reply(handleRun({ backend: backend as Backend, ...rest }, mcpSid));
    },
  );

  s.registerTool(
    "worker_resume",
    {
      description:
        "Resume stopped worker / retry failed|timeout. Pass original specFile + dir.",
      inputSchema: {
        handle: z.string(),
        specFile: specFileSchema,
        dir: z
          .string()
          .min(1)
          .refine((v) => v.startsWith("/"), "absolute path required")
          .describe("Repo directory (absolute path, required)"),
        timeout: z.number().int().min(1).max(3600).optional(),
        extraArgs: z
          .array(z.string().max(4096))
          .optional()
          .describe("Raw worker CLI args."),
      },
    },
    async (args) => reply(handleResume(args)),
  );

  s.registerTool(
    "worker_kill",
    {
      description: "Kill a running worker.",
      inputSchema: { handle: z.string() },
    },
    async (args) => reply(handleKill(args)),
  );

  s.registerTool(
    "worker_status",
    {
      description:
        "Worker state: status, pid, timing. Not a done-signal — use worker-report to wait for completion.",
      inputSchema: { handle: z.string() },
    },
    async (args) => reply(handleStatus(args)),
  );

  s.registerTool(
    "worker_extend",
    {
      description:
        "Push worker deadline +N sec (1..86400). Repeatable. Unextended → hard-killed ~60s past deadline.",
      inputSchema: {
        handle: z.string().describe("Worker handle"),
        seconds: z
          .number()
          .describe("Seconds to extend the deadline (1..86400)"),
      },
    },
    async (args) => reply(handleExtend(args)),
  );

  s.registerTool(
    "worker_doctor",
    {
      description: "Health check: names broken workers, else all-fine.",
      inputSchema: { backend: z.string().optional() },
    },
    async (args) => reply(await handleDoctor(args)),
  );

  s.registerTool(
    "worker_list",
    {
      description: "List recent jobs.",
      inputSchema: {
        status: z
          .string()
          .optional()
          .describe(
            "Filter by status: running|stopped|done|failed|timeout|killed",
          ),
        limit: z.number().optional().describe("Max results (default 20)"),
      },
    },
    async (args) => reply(handleList(args)),
  );

  s.registerTool(
    "worker_cleanup",
    {
      description:
        "Drop transcript (run.log) after diff reviewed. Keeps job.json + worktree + branch. No-op unless worker done.",
      inputSchema: { handle: z.string() },
    },
    async (args) => reply(pruneTranscript(args.handle)),
  );
  return s;
}

// One rotated generation: current log + <log>.1, ≤2MB each. Rotation happens on
// a whole-entry boundary, so nothing is truncated mid-line; beyond ~4MB the
// oldest entries age out instead of the file growing forever.
const MAX_SERVER_LOG_BYTES = 2 * 1024 * 1024;

function rotateIfHuge(logFile: string): void {
  try {
    if (statSync(logFile).size >= MAX_SERVER_LOG_BYTES)
      renameSync(logFile, `${logFile}.1`);
  } catch {}
}

function teeStderrToLog(): void {
  const logFile = join(workersDir(), "mcp-server.log");
  const orig = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    orig(...args);
    rotateIfHuge(logFile);
    const text = args
      .map((a) =>
        a instanceof Error
          ? (a.stack ?? a.message)
          : typeof a === "string"
            ? a
            : JSON.stringify(a),
      )
      .join(" ");
    try {
      appendFileSync(logFile, `${new Date().toLocaleString()} ${text}\n`);
    } catch {}
  };
}

function initDaemon(): void {
  teeStderrToLog();
  console.error("[worker] daemon initializing");
  workerEnv();
  sweepStaleJobs();
  reapStoppedJobs();
  sweepChainLocks();
  sweepStaleWorkerDirs();
}

if (import.meta.main) {
  initDaemon();

  // Process-level error handlers. console.error is tee'd to daemon.log (see
  // teeStderrToLog), so crashes land in the state dir with a timestamp even if
  // the launcher discards stderr.
  const recordCrash = (kind: string, err: unknown) => {
    const e =
      err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    console.error(`[worker] ${kind} (pid ${process.pid}):\n${e}`);
  };
  process.on("uncaughtException", (err) => {
    recordCrash("uncaught exception", err);
    removeServerPid(); // every exit path clears the .active/worker/ pid, including this crash route
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    recordCrash("unhandled rejection", reason);
  });

  const tracker = new SessionTracker();
  const IDLE_TTL_MS = 30 * 60_000;
  // JSON-RPC tool calls are tiny (spec travels by filename); anything huge is abuse.
  const MAX_BODY_BYTES = 4 * 1024 * 1024;
  let tick = 0;
  setInterval(() => {
    try {
      checkClientLiveness();
    } catch {}
    if (tick % 2 === 0) {
      reapStoppedJobs();
      sweepStaleJobs();
      sweepChainLocks();
      sweepStaleWorkerDirs();
      if (getAllRunningJobs().length) spawnReaper();
    }
    if (tick % 10 === 0) {
      try {
        tracker.reapIdle(IDLE_TTL_MS);
      } catch {}
    }
    tick = (tick + 1) % 10;
  }, 30_000).unref();

  // 404 tells the MCP client its session is gone → re-initialize. Returning a
  // generic 400 here instead wedges the client forever (it replays the dead id).
  const sessionNotFound = (res: http.ServerResponse) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      }),
    );
  };

  const httpServer = http.createServer(async (req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          sessions: tracker.size,
          uptime: process.uptime(),
        }),
      );
      return;
    }

    // MCP endpoint — plain stateless-routing StreamableHTTP. Sessions are just a
    // routing map; daemon lifecycle (and worker reaping) is owned by the
    // session-start/session-end hooks via a client-PID refcount, NOT by these
    // connections. SSE drops are transient and must never kill workers.
    if (req.url === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      // GET (open SSE stream) / DELETE (terminate session) on an existing session.
      if (req.method === "GET" || req.method === "DELETE") {
        const entry = sessionId ? tracker.get(sessionId) : undefined;
        if (!entry) {
          sessionNotFound(res);
          return;
        }
        entry.lastSeen = Date.now();
        await entry.transport.handleRequest(req, res);
        return;
      }

      // Reject oversized bodies on the declared length BEFORE reading — responding
      // after a mid-body break never reaches the client on Bun's node:http.
      const declaredLen = Number(req.headers["content-length"]);
      if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Request body too large" },
            id: null,
          }),
        );
        req.destroy();
        return;
      }

      // POST — pre-read body so we can route on the parsed JSON-RPC message.
      // Streamed cap backstops chunked/lying clients: no clean 413 is possible
      // mid-body (see above), so just bound memory and drop the connection.
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) {
          req.destroy();
          return;
        }
      }

      let parsed: unknown;
      try {
        parsed = body ? JSON.parse(body) : undefined;
      } catch (err) {
        console.error(
          "[worker] JSON parse error:",
          err instanceof Error ? err.message : err,
        );
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error" },
            id: null,
          }),
        );
        return;
      }

      if (sessionId) {
        const entry = tracker.get(sessionId);
        if (entry) {
          entry.lastSeen = Date.now();
          await entry.transport.handleRequest(req, res, parsed);
          return;
        }
        // Known-looking id, unknown to this daemon (restart / reaped) → 404.
        sessionNotFound(res);
        return;
      }

      // No session id → only an initialize request is valid.
      if (isInitializeRequest(parsed)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        const server = createWorkerServer();
        // Disconnect just forgets the session — never kills workers. They run to
        // completion; the last-instance-out hook (SIGTERM → hardShutdown) is the
        // only reaper. The daemon never self-terminates on an idle tracker.
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) tracker.remove(sid);
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, parsed);

        const mcpSid = transport.sessionId;
        if (mcpSid)
          tracker.register(mcpSid, { transport, server, lastSeen: Date.now() });
        return;
      }

      // Not an init, no valid session.
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request" },
          id: null,
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  // Try to bind. If port occupied, check if it's our daemon.
  const port = process.env.WORKER_PORT
    ? Number(process.env.WORKER_PORT)
    : 54321;
  httpServer.on("error", async (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      const existing = readLock();
      if (existing && (await isDaemonAlive(existing))) {
        console.error(
          `Daemon already running on port ${existing.port} (PID ${existing.pid}). Reusing.`,
        );
        process.exit(0);
      }
      // Stale or foreign process — try to reclaim
      console.error(
        `Port ${port} occupied. Removing stale lockfile and retrying...`,
      );
      removeLock();
      httpServer.listen(port, "127.0.0.1");
    } else {
      console.error("HTTP server error:", err);
      process.exit(1);
    }
  });

  // Loopback only — clients always dial 127.0.0.1 (see isDaemonAlive); a wildcard
  // bind exposes worker spawning to the LAN.
  httpServer.listen(port, "127.0.0.1", () => {
    const actualPort = (httpServer.address() as { port: number }).port;
    if (!acquireLock(process.pid, actualPort)) {
      console.error(
        "Failed to acquire lockfile. Another daemon may have started.",
      );
      httpServer.close();
      process.exit(1);
    }
    console.error(
      `[worker] daemon listening on http://127.0.0.1:${actualPort}/mcp`,
    );
    writeServerPid();
  });

  const gracefulShutdown = (sig: string) => () => {
    console.error(
      `[worker] received ${sig} (pid ${process.pid}), shutting down`,
    );
    hardShutdown();
  };
  // Log signals/exit so a death leaves a trace. NOTE: SIGKILL, OOM-kill, and
  // segfaults cannot be caught in-process — if the log just stops with no exit
  // line below, the OS or a supervisor hard-killed it (check Console.app / `log show`).
  process.on("SIGTERM", gracefulShutdown("SIGTERM"));
  process.on("SIGINT", gracefulShutdown("SIGINT"));
  process.on("SIGHUP", gracefulShutdown("SIGHUP"));
  process.on("exit", (code) => {
    console.error(`[worker] process exit, code ${code} (pid ${process.pid})`);
  });
}
