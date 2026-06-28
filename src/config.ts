import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod/v4";

export type FileConfig = {
  ladder?: string[];
  skip?: string[];
  verifyCmd?: string;
  stateDir?: string;
  plansDir?: string;
  retainMs?: number;
  reportPollMs?: number;
  rc?: string,
  loginShell?: boolean;
  cpuQos?: string;
  gpgMode?: string;
  gpgKeygrip?: string;
};

const stringArrayCoerce = z
  .array(z.unknown())
  .transform((arr) => arr.filter((e): e is string => typeof e === "string"))
  .pipe(z.array(z.string()));
const FileConfigSchema = z.object({
  ladder: stringArrayCoerce.optional(),
  skip: stringArrayCoerce.optional(),
  verifyCmd: z.string().optional(),
  stateDir: z.string().optional(),
  plansDir: z.string().optional(),
  retainMs: z.number().nonnegative().finite().optional(),
  reportPollMs: z.number().nonnegative().finite().optional(),
  rc: z.string().optional(),
  loginShell: z.boolean().optional(),
  cpuQos: z.string().optional(),
  gpgMode: z.string().optional(),
  gpgKeygrip: z.string().optional(),
});

function loadFileConfig(pathOverride?: string): FileConfig {
  const home = process.env.HOME ?? "";
  const configPath =
    pathOverride ??
    process.env.WORKER_CONFIG_PATH ??
    join(home, ".claude", "workers", "config.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    if (err?.code === "ENOENT") return {};
    console.error(
      `[config] failed to read config.json: ${err?.message ?? err}`,
    );
    return {};
  }
  const result = FileConfigSchema.safeParse(raw);
  if (!result.success) return {};
  return result.data;
}

export const FILE_CONFIG = loadFileConfig();

export { loadFileConfig };
