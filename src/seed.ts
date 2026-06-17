export type SeedContext = {
  priorBackend: string;
  priorStatus: string;
};

export function buildContinuationPreamble(seed: SeedContext): string {
  return `Continuation. A previous agent (${seed.priorBackend}) was interrupted (${seed.priorStatus}) — likely infra, not bad work. Its in-progress changes are ALREADY applied in this worktree. Review them, finish what is incomplete, do not restart from scratch.\n\n`;
}
