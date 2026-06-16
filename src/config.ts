import { readFileSync } from 'fs';
import { join } from 'path';

export type FileConfig = {
  ladder?: string[];
  skip?: string[];
  verifyCmd?: string;
  stateDir?: string;
  plansDir?: string;
  retainMs?: number;
  reportPollMs?: number;
  rc?: string;
  loginShell?: boolean;
};

function loadFileConfig(pathOverride?: string): FileConfig {
  const home = process.env.HOME ?? '';
  const configPath = pathOverride ?? join(home, '.claude', 'workers', 'config.json');

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (e: any) {
    if (e?.code === 'ENOENT') return {};
    console.error(`[config] failed to read config.json: ${e?.message ?? e}`);
    return {};
  }

  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const result: FileConfig = {};
  const parsed = raw as Record<string, unknown>;

  if (Array.isArray(parsed.ladder)) {
    const ladder = parsed.ladder.filter((e): e is string => typeof e === 'string');
    if (ladder.length > 0) result.ladder = ladder;
  }

  if (Array.isArray(parsed.skip)) {
    const skip = parsed.skip.filter((e): e is string => typeof e === 'string');
    if (skip.length > 0) result.skip = skip;
  }

  if (typeof parsed.verifyCmd === 'string') {
    result.verifyCmd = parsed.verifyCmd;
  }

  if (typeof parsed.stateDir === 'string') {
    result.stateDir = parsed.stateDir;
  }

  if (typeof parsed.plansDir === 'string') {
    result.plansDir = parsed.plansDir;
  }

  if (typeof parsed.retainMs === 'number' && Number.isFinite(parsed.retainMs) && parsed.retainMs > 0) {
    result.retainMs = parsed.retainMs;
  }

  if (typeof parsed.reportPollMs === 'number' && Number.isFinite(parsed.reportPollMs) && parsed.reportPollMs > 0) {
    result.reportPollMs = parsed.reportPollMs;
  }

  if (typeof parsed.rc === 'string') {
    result.rc = parsed.rc;
  }

  if (typeof parsed.loginShell === 'boolean') {
    result.loginShell = parsed.loginShell;
  }

  return result;
}

export const FILE_CONFIG = loadFileConfig();

// Export for testing
export { loadFileConfig };