import { describe, expect, it } from 'vitest';
import type { FastMoneyRoundDef } from '../rules';
import { FAST_MONEY, Sim } from './testkit';

const def = (over: Partial<FastMoneyRoundDef> = {}): FastMoneyRoundDef => ({ ...FAST_MONEY, questions: 2, ...over });

/** ann 500, bob 300, cat 100: ann and bob are the finalists, ann first. */
function sim(over: Partial<FastMoneyRoundDef> = {}) {
  const s = new Sim({ rounds: [def(over)] });
  s.host({ t: 'score.set', id: 'ann', score: 500 }).host({ t: 'score.set', id: 'bob', score: 300 }).host({ t: 'score.set', id: 'cat', score: 100 });
  return s.start();
}
const revealAll = (s: Sim) => {
  const secret = s.secret.round!;
  if (secret.mode !== 'fastMoney') throw new Error('not fast money');
  for (let i = secret.revealStep; i < secret.revealLimit; i++) s.host({ t: 'fm.reveal' });
};

describe('fast money: head-to-head decider', () => {
  it('seeds the top two, leader first, and gives later turns extra time', () => {
    const s = sim();
    expect(s.fm).toMatchObject({ stage: 'ready', turns: [['ann'], ['bob']], turn: 0 });
    expect(s.you('ann').fastMoney).toMatchObject({ when: 'now', active: false });
    expect(s.you('bob').fastMoney).toMatchObject({ when: 'before' });
    expect(s.you('cat').fastMoney).toBeNull();
    s.host({ t: 'fm.start' });
    expect(s.fm.timer!.totalMs).toBe(45_000);
    s.player('ann', { t: 'fm.done' });
    expect(s.fm).toMatchObject({ stage: 'ready', turn: 1 });
    s.host({ t: 'fm.start' });
    expect(s.fm.timer!.totalMs).toBe(55_000);
  });

  it('matches answers, blocks duplicates and keeps answers hidden until revealed', () => {
    const s = sim();
    s.host({ t: 'fm.start' });
    s.player('ann', { t: 'fm.answer', q: 0, text: 'Apples!' }).player('ann', { t: 'fm.answer', q: 1, text: 'kiwi' });
    expect(() => s.player('bob', { t: 'fm.answer', q: 0, text: 'pear' })).toThrow(/not your turn/);
    expect(JSON.stringify(s.pub)).not.toMatch(/Apples|kiwi/);
    expect(s.fm.progress.ann).toEqual({ answered: 2, finished: false });
    s.advance(45_000); // time runs out
    s.host({ t: 'fm.start' });
    expect(() => s.player('bob', { t: 'fm.answer', q: 0, text: 'an apple' })).toThrow(/Already taken/);
    expect(() => s.player('bob', { t: 'fm.answer', q: 1, text: 'Kiwis' })).toThrow(/Already taken/);
    s.player('bob', { t: 'fm.answer', q: 0, text: 'bananna' }).player('bob', { t: 'fm.answer', q: 1, text: 'clementine' });
    expect(s.you('bob').fastMoney!.answers).toEqual(['bananna', 'clementine']);
    s.player('bob', { t: 'fm.done' });
    expect(s.fm.stage).toBe('reveal');

    const secret = s.secret.round!;
    expect(secret.mode === 'fastMoney' && secret.responses.bob.map((r) => [r.match, r.points, r.matchedBy])).toEqual([
      [1, 30, 'fuzzy'],
      [2, 20, 'exact'],
    ]);
  });

  it('reveals side by side, question by question, and the higher survey total wins outright', () => {
    const s = sim();
    s.host({ t: 'fm.start' });
    s.player('ann', { t: 'fm.answer', q: 0, text: 'strawberry' }).player('ann', { t: 'fm.done' });
    s.host({ t: 'fm.start' });
    s.player('bob', { t: 'fm.answer', q: 0, text: 'apple' }).player('bob', { t: 'fm.answer', q: 1, text: 'orange' }).player('bob', { t: 'fm.done' });

    s.host({ t: 'fm.reveal' });
    expect(s.fm.cells.ann[0]).toEqual({ text: 'strawberry', points: null });
    expect(s.fm.focus).toEqual({ turn: 0, q: 0, step: 1 });
    s.host({ t: 'fm.reveal' });
    expect(s.fm.cells.ann[0]).toEqual({ text: 'strawberry', points: 10 });
    expect(s.fm.cells.bob[0]).toEqual({ text: null, points: null });
    s.host({ t: 'fm.reveal' });
    expect(s.fm.focus).toEqual({ turn: 1, q: 0, step: 1 });
    expect(() => s.host({ t: 'fm.next' })).toThrow(/Finish the reveals/);
    revealAll(s);
    expect(s.fm.totals).toEqual({ ann: 10, bob: 60 });
    expect(() => s.host({ t: 'fm.reveal' })).toThrow(/Everything/);

    s.host({ t: 'fm.next' });
    expect(s.fm).toMatchObject({ stage: 'result', outcome: { winners: ['bob'], totals: { ann: 10, bob: 60 } } });
    expect(s.fm.topAnswers[0]).toEqual({ text: 'Apple', points: 40 });
    // Board scores are untouched; the decider names the champion.
    expect([s.score('ann'), s.score('bob')]).toEqual([500, 300]);
    s.host({ t: 'round.end' });
    expect(s.pub).toMatchObject({ phase: 'finished', champions: ['bob'] });
  });

  it('lets the host fix a match before or after the points are shown', () => {
    const s = sim({ stakes: 'points', pointMultiplier: 10 });
    s.host({ t: 'fm.start' });
    s.player('ann', { t: 'fm.answer', q: 0, text: 'granny smith' }).player('ann', { t: 'fm.done' });
    s.host({ t: 'fm.start' }).host({ t: 'fm.setAnswer', playerId: 'bob', q: 0, text: 'banana' }).host({ t: 'fm.endTurn' });
    s.host({ t: 'fm.reveal' }).host({ t: 'fm.reveal' });
    expect(s.score('ann')).toBe(500);
    s.host({ t: 'fm.override', playerId: 'ann', q: 0, match: 0 });
    expect(s.score('ann')).toBe(900);
    expect(s.fm.cells.ann[0].points).toBe(40);
    expect(() => s.host({ t: 'fm.setAnswer', playerId: 'ann', q: 0, text: 'x' })).toThrow(/already been revealed/);
    s.host({ t: 'fm.override', playerId: 'bob', q: 0, match: null });
    revealAll(s);
    expect(s.score('bob')).toBe(300);
  });
});

describe('fast money: classic jackpot', () => {
  const classic = { reveal: 'afterEachTurn', stakes: 'points', pointMultiplier: 10, target: 100, targetBonus: 5000 } as const;

  it('reveals between turns, covers earlier answers, and pays the bonus for a combined target', () => {
    const s = sim(classic);
    s.host({ t: 'fm.start' });
    s.player('ann', { t: 'fm.answer', q: 0, text: 'apple' }).player('ann', { t: 'fm.answer', q: 1, text: 'banana' }).player('ann', { t: 'fm.done' });
    expect(s.fm.stage).toBe('reveal');
    revealAll(s);
    expect(s.score('ann')).toBe(500 + 700);
    s.host({ t: 'fm.next' }).host({ t: 'fm.start' });
    expect(s.fm).toMatchObject({ turn: 1, covered: true });
    s.player('bob', { t: 'fm.answer', q: 0, text: 'orange' }).player('bob', { t: 'fm.answer', q: 1, text: 'strawberry' }).player('bob', { t: 'fm.done' });
    revealAll(s);
    s.host({ t: 'fm.next' });
    expect(s.fm.outcome).toMatchObject({ combined: 100, targetHit: true, winners: ['ann', 'bob'] });
    expect([s.score('ann'), s.score('bob')]).toEqual([1200 + 5000, 300 + 300 + 5000]);
    expect(s.eventTypes()).toContain('fm.result');
  });

  it('misses the target without a bonus', () => {
    const s = sim({ ...classic, participants: 'leader' });
    s.host({ t: 'fm.start' }).host({ t: 'fm.endTurn' });
    revealAll(s);
    s.host({ t: 'fm.next' });
    expect(s.fm.outcome).toMatchObject({ targetHit: false, winners: [] });
    expect(s.score('ann')).toBe(500);
  });
});

describe('fast money: everybody plays', () => {
  it('has all active players answer at once and scores each of them', () => {
    const s = sim({ participants: 'all', blockDuplicates: false, stakes: 'points', pointMultiplier: 5, extraSecPerTurn: 0 });
    expect(s.fm.turns).toEqual([['ann', 'bob', 'cat']]);
    s.host({ t: 'fm.start' });
    for (const p of ['ann', 'bob', 'cat']) s.player(p, { t: 'fm.answer', q: 0, text: 'apple' });
    s.player('ann', { t: 'fm.done' }).player('bob', { t: 'fm.done' });
    expect(s.fm.stage).toBe('answering');
    s.host({ t: 'player.kick', id: 'cat' }); // a leaver must not hold the round up
    s.player('ann', { t: 'ready', ready: true });
    s.advance(45_000);
    expect(s.fm.stage).toBe('reveal');
    s.host({ t: 'fm.reveal' }).host({ t: 'fm.reveal' });
    expect([s.score('ann'), s.score('bob')]).toEqual([700, 500]);
  });
});
