import { readSentinel } from './logParse.ts';
import { emitsJsonLog } from './backends.ts';

// Shared status resolver — used by both runner.ts (live job finalization) and
// maintenance.ts (orphan sweep's dead-worker branch). Lives in its own module
// so neither side needs to import from the other (no cycle).
export function resolveStatus(backend: string, rc: number, logPath: string, timedOut: boolean): string {
  if (timedOut) return 'timeout';
  const { status } = readSentinel(logPath, emitsJsonLog(backend));
  if (status) return status;
  if (backend === 'cmd') return rc === 0 ? 'done' : rc === 8 ? 'failed:max-turns' : 'failed';
  if (backend === 'pool') return rc === 0 ? 'done' : rc === 4 ? 'failed:task' : 'failed';
  return rc === 0 ? 'done' : 'failed';
}
