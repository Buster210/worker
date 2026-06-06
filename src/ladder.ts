import { getLadderHistory, appendLadder } from './state.ts';
import { LADDER, type Backend } from './backends.ts';

export function ladderNext(sid: string, climb: boolean): { backend: Backend; turn: number } | null {
  const history = getLadderHistory(sid);
  const turns = history.length;
  if (turns === 0) return { backend: LADDER[0], turn: 1 };

  const lastWorker = history[history.length - 1].worker as Backend;
  const lastIdx = LADDER.indexOf(lastWorker);
  if (lastIdx === -1) return { backend: LADDER[0], turn: turns + 1 };

  const nextIdx = climb ? lastIdx + 1 : lastIdx;
  if (nextIdx >= LADDER.length) return null;

  return { backend: LADDER[nextIdx], turn: turns + 1 };
}

export function recordLadder(sid: string, turn: number, worker: string, result: string) {
  appendLadder(sid, turn, worker, result);
}
