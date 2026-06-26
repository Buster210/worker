import { describe, it, expect, afterAll } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

const STATE_DIR = join(tmpdir(), `wchain-format-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;

import { handleLadder } from '../src/chain.ts';

afterAll(() => {
  try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}
});

const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('chain handle format — runtime guarantee (claude --session-id safe)', () => {
  it('handleLadder mints a full-UUID handle and hands that exact handle to the first rung', () => {
    // Inject a stub launcher (test seam) — no real backend spawns; record the launched handle.
    // Resolve 'done' so the chain settles on the first rung — no climb, no dangling async.
    const launched: Array<string | undefined> = [];
    const stubLaunch = ((backend: string, _prompt: string, dir: string, opts: { handle?: string }) => {
      launched.push(opts.handle);
      return {
        handle: opts.handle ?? 'unset',
        promise: Promise.resolve({ status: 'done', exit_code: 0, backend, handle: opts.handle ?? 'unset', resume_token: '', repo: dir, log: '' }),
        workdir: dir,
      };
    }) as unknown as NonNullable<Parameters<typeof handleLadder>[1]>['launch'];

    const res = handleLadder({ mcpSid: 'm', prompt: 'p', dir: '/tmp/test-repo' }, { launch: stubLaunch });
    if (!('handle' in res)) throw new Error(`expected a running chain handle, got: ${JSON.stringify(res)}`);

    // A regression to newHandle(backend) returns 'w-<8hex>', which claude/claude_tmux reject as a
    // --session-id. The returned handle must be a full UUID and must NOT be the short form.
    expect(res.handle).toMatch(FULL_UUID);
    expect(res.handle.startsWith('w-')).toBe(false);
    // The first rung must receive the SHARED handle, not a freshly-minted per-rung one.
    expect(launched.length).toBeGreaterThan(0);
    expect(launched[0]).toBe(res.handle);
  });
});
