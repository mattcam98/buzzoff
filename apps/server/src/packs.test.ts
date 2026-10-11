/** The question pack that ships in `packs/`: it must import as it is, and deal the way its size promises. */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assembleRounds, BUILTIN_PRESETS, clueKey, matchSurvey, PackFileSchema, type Played } from '@buzzoff/shared';
import { describe, expect, it } from 'vitest';

const dir = path.resolve(__dirname, '../../../packs');
const files = readdirSync(dir).filter((name) => name.endsWith('.buzzoff.json'));
const read = (file: string) => PackFileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).pack;

/** A survey is a hundred people's answers: the points say how many of them gave each one. */
describe.each([...files.map((name) => path.join(dir, name)), path.resolve(__dirname, 'seed/starter-pack.json')])('the surveys in %s', (file) => {
  const { surveys } = read(file);

  it('add up to 100 each, most popular answer first', () => {
    for (const s of surveys) {
      expect([s.question, s.answers.reduce((n, a) => n + a.points, 0)]).toEqual([s.question, 100]);
      expect([s.question, s.answers.map((a) => a.points)]).toEqual([s.question, s.answers.map((a) => a.points).sort((a, b) => b - a)]);
    }
  });

  it('score every accepted phrase as the answer it was written for', () => {
    for (const s of surveys) {
      for (const [i, answer] of s.answers.entries()) {
        for (const phrase of [answer.text, ...answer.aliases]) expect([s.question, phrase, matchSurvey(phrase, s.answers)?.index]).toEqual([s.question, phrase, i]);
      }
    }
  });
});

describe.each(files)('%s', (name) => {
  const pack = read(path.join(dir, name));

  it('is a valid pack with a full ladder of values in every category', () => {
    expect(pack.categories.length).toBeGreaterThan(0);
    for (const cat of pack.categories) {
      expect([cat.title, [...new Set(cat.clues.map((c) => c.value))].sort((a, b) => a - b)]).toEqual([cat.title, [100, 200, 300, 400, 500]]);
      expect([cat.title, new Set(cat.clues.map((c) => c.id)).size]).toEqual([cat.title, cat.clues.length]);
      // Every category is a pool: at least four clues to choose from at every value.
      for (const value of [100, 200, 300, 400, 500]) expect([cat.title, value, cat.clues.filter((c) => c.value === value).length >= 4]).toEqual([cat.title, value, true]);
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
