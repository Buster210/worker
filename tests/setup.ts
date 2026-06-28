// Disable the cmd/codex auth probe in the test process so computeLadder()/LADDER stay
// deterministic and spawn-free. Real probing only happens in the live server.
process.env.WORKER_SKIP_AUTH_GATE = "1";

// Hermetic config: point WORKER_CONFIG_PATH at a nonexistent file BEFORE any src module
// imports, so config.ts:loadFileConfig() (evaluated at import time) sees no real
// ~/.claude/workers/config.json (ENOENT → {}) and falls back to defaults. Without this, a
// dev's custom `ladder` order poisons computeLadder()/LADDER assertions. HOME is left real
// so real-CLI tests (omp/codex) still find their own auth/config.
process.env.WORKER_CONFIG_PATH = "/nonexistent/worker-test-config.json";

// Hermetic state-dir baseline: without this, any test whose own WORKER_STATE_DIR is unset at
// execution time (module-load order can clobber it across the shared test process) falls back to
// the REAL ~/.claude/workers, whose live jobs make isInPlaceOwner/handleRun see foreign owners.
// Files that set their own WORKER_STATE_DIR still win; this only replaces the real-dir fallback.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
process.env.WORKER_STATE_DIR = mkdtempSync(
  join(tmpdir(), "worker-test-state-"),
);
