import { appendLadder } from './state.ts';

export function recordLadder(sid: string, turn: number, worker: string, result: string) {
  appendLadder(sid, turn, worker, result);
}
