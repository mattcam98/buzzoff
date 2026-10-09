import type { GameResult } from '@buzzoff/shared';
import { describe, expect, it } from 'vitest';
import { Results } from './results';
import { MemoryStore } from './store/memory';

const result = (id: string): GameResult => ({ id, code: 'BCDF', name: 'Night', packTitles: [], startedAt: 1, finishedAt: 2, rounds: [], players: [], teams: null });

describe('results', () => {
  it('makes changes in the order they were asked for, however long the store takes over each', async () => {
    // Slow to save and quick to delete, as a database under load can be.
    class SlowToSave extends MemoryStore {
      override async saveResult(saved: GameResult) {
        await new Promise((done) => setTimeout(done, 30));
        await super.saveResult(saved);
      }
    }
    const results = await Results.load(new SlowToSave());
    // A game ends and the host undoes that at once.
    await Promise.all([results.save(result('one')), results.remove('one')]);
    expect(await results.list(10)).toEqual([]);
  });

  it('carries on after a change the store refused', async () => {
    let failing = true;
    class Flaky extends MemoryStore {
      override async saveResult(saved: GameResult) {
        if (failing) throw new Error('connection lost');
        await super.saveResult(saved);
      }
    }
    const results = await Results.load(new Flaky());
    await expect(results.save(result('one'))).rejects.toThrow('connection lost');
    failing = false;
    await results.save(result('two'));
    expect((await results.list(10)).map((r) => r.id)).toEqual(['two']);
  });
});
