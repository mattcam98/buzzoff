import { describe, expect, it } from 'vitest';
import { GameError } from './core';
import { nextDeadline } from './game';
import { Sim, TRIVIA } from './testkit';

/** A game sitting at the roll for the first pick, with dice that come up as told. */
function atTheRoll(faces: number[], players = ['ann', 'bob', 'cat']) {
  const s = new Sim({ players });
  // Each face is turned into the random number that produces it: the engine does 1 + floor(rand * 6).
  s.rand = () => (faces.shift()! - 0.5) / 6;
  return s.host({ t: 'start' }).host({ t: 'round.begin' });
}
const settle = (s: Sim) => s.advance(nextDeadline(s.state)! - s.now);

describe('rolling for the first pick', () => {
  it('opens the first board with every player rolling, and gives the highest roll the board', () => {
    const s = atTheRoll([3, 5, 2]);
    expect(s.trivia).toMatchObject({ stage: 'roll', controlId: null, roll: { round: 1, phase: 'rolling', contenders: ['ann', 'bob', 'cat'], rolls: {} } });
    expect(() => s.host({ t: 'clue.select', cat: 0, idx: 0 })).toThrow(/from the board/);

    s.player('ann', { t: 'roll' });
    expect(s.trivia.roll).toMatchObject({ phase: 'rolling', rolls: { ann: 3 } });
    expect(s.events.at(-1)).toEqual({ type: 'dice.rolled', playerId: 'ann', value: 3 });
    expect(() => s.player('ann', { t: 'roll' })).toThrow(/already rolled/);
    s.player('bob', { t: 'roll' }).player('cat', { t: 'roll' });
    // The last die gets a moment to land before the result is called.
    expect(s.trivia.roll).toMatchObject({ phase: 'landing', winnerId: null });

    settle(s);
    expect(s.trivia).toMatchObject({ stage: 'roll', controlId: 'bob', roll: { phase: 'won', winnerId: 'bob' } });
    expect(s.events.at(-1)).toEqual({ type: 'dice.won', playerId: 'bob' });
    settle(s);
    expect(s.trivia).toMatchObject({ stage: 'board', controlId: 'bob', roll: null });
    s.host({ t: 'clue.select', cat: 0, idx: 0 });
    expect(s.trivia.clue!.stage).toBe('open');
  });

  it('has only the tied players roll again, as often as it takes', () => {
    const s = atTheRoll([6, 2, 6, 4, 4, 1, 5]);
    for (const id of ['ann', 'bob', 'cat']) s.player(id, { t: 'roll' });
    settle(s);
    expect(s.trivia.roll).toMatchObject({ phase: 'tied', contenders: ['ann', 'bob', 'cat'], rolls: { ann: 6, bob: 2, cat: 6 } });
    expect(s.events.at(-1)).toEqual({ type: 'dice.tied', playerIds: ['ann', 'cat'] });

    settle(s);
    expect(s.trivia.roll).toMatchObject({ round: 2, phase: 'rolling', contenders: ['ann', 'cat'], rolls: {}, out: { bob: 2 } });
    expect(() => s.player('bob', { t: 'roll' })).toThrow(/not in this roll/);
    s.player('ann', { t: 'roll' }).player('cat', { t: 'roll' });
    settle(s);
    expect(s.trivia.roll).toMatchObject({ phase: 'tied', rolls: { ann: 4, cat: 4 } });

    settle(s);
    s.player('cat', { t: 'roll' }).player('ann', { t: 'roll' });
    settle(s);
    expect(s.trivia).toMatchObject({ controlId: 'ann', roll: { round: 3, phase: 'won', winnerId: 'ann', rolls: { cat: 1, ann: 5 }, out: { bob: 2 } } });
  });

  it('waits for everyone however long they take, until the host rolls for the rest', () => {
    const s = atTheRoll([1, 6, 3]);
    s.player('ann', { t: 'roll' });
    // No clock is running, on the first roll or on a tie-break.
    expect(nextDeadline(s.state)).toBeNull();
    s.advance(10 * 60_000);
    expect(s.trivia.roll).toMatchObject({ phase: 'rolling', rolls: { ann: 1 } });
    s.host({ t: 'roll.finish' });
    expect(s.trivia.roll).toMatchObject({ phase: 'landing', rolls: { ann: 1, bob: 6, cat: 3 } });

    const tie = atTheRoll([4, 4, 2]);
    for (const id of ['ann', 'bob', 'cat']) tie.player(id, { t: 'roll' });
    settle(tie);
    settle(tie);
    expect(tie.trivia.roll).toMatchObject({ round: 2, phase: 'rolling', contenders: ['ann', 'bob'] });
    expect(nextDeadline(tie.state)).toBeNull();

    const t = atTheRoll([2, 2, 5]);
    t.host({ t: 'roll.finish' });
    expect(t.trivia.roll).toMatchObject({ phase: 'landing', rolls: { ann: 2, bob: 2, cat: 5 } });
    expect(() => t.host({ t: 'roll.finish' })).toThrow(GameError);
  });

  it('is skipped when there is nobody to roll against, and on later boards', () => {
    const solo = new Sim({ players: ['ann'] }).host({ t: 'start' }).host({ t: 'round.begin' });
    expect(solo.trivia).toMatchObject({ stage: 'board', controlId: 'ann', roll: null });

    const s = new Sim({ rounds: [TRIVIA, TRIVIA] }).start();
    s.host({ t: 'score.adjust', id: 'bob', delta: -100 }).host({ t: 'round.end' }).host({ t: 'round.next' }).host({ t: 'round.begin' });
    expect(s.trivia).toMatchObject({ stage: 'board', controlId: 'bob', roll: null });
  });

  it('ends at once if the host simply hands someone the board', () => {
    const s = atTheRoll([4]);
    s.player('ann', { t: 'roll' });
    s.host({ t: 'control.set', id: 'cat' });
    expect(s.trivia).toMatchObject({ stage: 'board', controlId: 'cat', roll: null });
    expect(nextDeadline(s.state)).toBeNull();
  });

  it('carries on without a player who is removed, and stands still while paused', () => {
    const s = atTheRoll([5, 5, 3]);
    s.player('ann', { t: 'roll' }).player('bob', { t: 'roll' });
    s.host({ t: 'player.kick', id: 'bob' });
    expect(s.trivia.roll).toMatchObject({ contenders: ['ann', 'cat'], rolls: { ann: 5 } });

    s.host({ t: 'pause', paused: true });
    expect(() => s.player('cat', { t: 'roll' })).toThrow(/paused/);
    s.advance(60_000);
    expect(s.trivia.roll!.phase).toBe('rolling');
    s.host({ t: 'pause', paused: false });
    s.player('cat', { t: 'roll' });
    settle(s);
    expect(s.trivia.roll).toMatchObject({ phase: 'won', winnerId: 'ann' });
  });

  it('is fair: over many rolls every face and every seat comes up about as often', () => {
    const faces = [0, 0, 0, 0, 0, 0];
    const wins: Record<string, number> = { ann: 0, bob: 0, cat: 0 };
    for (let game = 0; game < 600; game++) {
      const s = new Sim();
      s.rand = Math.random;
      s.host({ t: 'start' }).host({ t: 'round.begin' }).rollOff();
      wins[s.trivia.controlId!] += 1;
      for (const e of s.events) if (e.type === 'dice.rolled') faces[e.value - 1] += 1;
    }
    const rolls = faces.reduce((n, f) => n + f, 0);
    for (const count of faces) expect(count / rolls).toBeGreaterThan(0.12);
    for (const count of Object.values(wins)) expect(count / 600).toBeGreaterThan(0.25);
  });
});
