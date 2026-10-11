/** The question pack that ships in `packs/`: it must import as it is, and deal the way its size promises. */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assembleRounds, BUILTIN_PRESETS, clueKey, PackFileSchema, type Played } from '@buzzoff/shared';
import { describe, expect, it } from 'vitest';

const dir = path.resolve(__dirname, '../../../packs');
const files = readdirSync(dir).filter((name) => name.endsWith('.buzzoff.json'));

describe.each(files)('%s', (name) => {
  const { pack } = PackFileSchema.parse(JSON.parse(readFileSync(path.join(dir, name), 'utf8')));

  it('is a valid pack with a full ladder of values in every category', () => {
    expect(pack.categories.length).toBeGreaterThan(0);
    for (const cat of pack.categories) {
      expect([cat.title, [...new Set(cat.clues.map((c) => c.value))].sort((a, b) => a - b)]).toEqual([cat.title, [100, 200, 300, 400, 500]]);
      expect([cat.title, new Set(cat.clues.map((c) => c.id)).size]).toEqual([cat.title, cat.clues.length]);
    }
    expect(new Set(pack.categories.map((c) => c.title)).size).toBe(pack.categories.length);
    expect(new Set(pack.surveys.map((s) => s.question)).size).toBe(pack.surveys.length);
  });

  it('plays The Full Show ten times running without asking anything twice', () => {
    const rules = BUILTIN_PRESETS[0].rules;
    const played: Played = {};
    const seen = new Set<string>();
    for (let game = 1; game <= 10; game++) {
      const rounds = assembleRounds(rules, pack, undefined, Math.random, played);
      const asked = rounds.flatMap((r) => {
        if (r.mode === 'trivia') {
          for (const cat of r.board) expect([cat.title, cat.clues.map((c) => c.value / r.def.valueMultiplier)]).toEqual([cat.title, [100, 200, 300, 400, 500]]);
          return r.board.flatMap((cat) => [cat.id!, ...cat.clues.map((c) => clueKey(cat.id!, c.id!))]);
        }
        return r.mode === 'final' ? [r.categoryId!, clueKey(r.categoryId!, r.clue.id!)] : r.surveys.map((s) => s.id);
      });
      for (const id of asked) {
        expect([game, id, seen.has(id)]).toEqual([game, id, false]);
        seen.add(id);
        played[id] = game;
      }
    }
  });
});
