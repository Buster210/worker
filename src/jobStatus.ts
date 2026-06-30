import { getJobFresh } from "./state.ts";

// ponytail: split out of report.ts so server.ts (a build entry) never imports report.ts
// (a separate build entry with a top-level `if (import.meta.main)` CLI block) — bundling
// two entries together makes Bun resolve import.meta.main to true for the whole merged
// chunk, so report.ts's CLI-usage branch ran and process.exit(1)'d before the daemon's
// HTTP server ever started listening.
export function terminalStatus(handle: string, lockPath: string): string {
  if (lockPath.endsWith(".chain.lock")) {
    // With the shared chain handle, getJobFresh reflects the active/terminal rung's live status.
    // Terminal winning rung (done/killed/timeout) → trust the live job; all-rungs-failed → exhausted.
    const status = getJobFresh(handle)?.status;
    if (status === "done" || status === "killed" || status === "timeout")
      return status;
    return "exhausted";
  }
  return getJobFresh(handle)?.status ?? "failed";
}
