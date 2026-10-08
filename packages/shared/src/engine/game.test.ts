import { describe, expect, it } from 'vitest';
import { applySystem, assembleRounds, restoreSnapshot } from './game';
import { GameError } from './core';
import { BUILTIN_PRESETS, GameRulesSchema } from '../rules';
import { categories, FAST_MONEY, FINAL, Sim, surveys, TRIVIA } from './testkit';

describe('lobby', () => {
  it('rejects duplicate names, full rooms, locked rooms and late joins when disabled', () => {
    const s = new Sim({ rules: { maxPlayers: 4, lateJoin: false } });
    expect(() => s.join('ANN')).toThrow(/already has that name/);
    s.join('dan');
    expect(() => s.join('eve')).toThrow(/full/);
    s.host({ t: 'player.kick', id: 'dan' }).host({ t: 'lobby.lock', locked: true });
    expect(() => s.join('eve')).toThrow(/locked/);
    s.host({ t: 'lobby.lock', locked: false }).host({ t: 'start' });
    expect(() => s.join('eve')).toThrow(/already started/);
  });

  it('needs a player to start and only starts once', () => {
    const s = new Sim({ players: [] });
    expect(() => s.host({ t: 'start' })).toThrow(GameError);
    s.join('ann');
    s.host({ t: 'start' });
    expect(() => s.host({ t: 'start' })).toThrow(GameError);
    expect(s.pub).toMatchObject({ phase: 'round', roundIndex: 0 });
    expect(s.trivia.stage).toBe('intro');
  });

  it('lets players ready up and edit their profile only in the lobby', () => {
    const s = new Sim();
    s.player('ann', { t: 'ready', ready: true }).player('ann', { t: 'profile', name: 'Annie', avatar: { emoji: '🦊', color: '#FF4D8D' } });
    expect(s.pub.players[0]).toMatchObject({ name: 'Annie', ready: true, avatar: { emoji: '🦊' } });
    expect(() => s.player('bob', { t: 'profile', name: 'annie', avatar: { emoji: '🦊', color: '#FF4D8D' } })).toThrow(/name/);
    s.host({ t: 'start' });
    expect(() => s.player('bob', { t: 'profile', name: 'Bobby', avatar: { emoji: '🦊', color: '#FF4D8D' } })).toThrow(GameError);
  });
});

describe('round flow', () => {
  it('walks lobby → rounds → standings → finished and crowns the top score', () => {
    const s = new Sim({ rounds: [TRIVIA, TRIVIA] }).start();
    s.host({ t: 'score.adjust', id: 'bob', delta: 500 }).host({ t: 'round.end' });
    expect(s.pub.phase).toBe('standings');
    // The trailing player opens the next board.
    s.host({ t: 'round.next' }).host({ t: 'round.begin' });
    expect(['ann', 'cat']).toContain(s.trivia.controlId);
    s.host({ t: 'round.end' });
    expect(s.pub).toMatchObject({ phase: 'finished', champions: ['bob'] });
    expect(s.eventTypes()).toContain('game.finished');
  });

  it('eliminates the lowest scorers at the end of a round but always keeps two', () => {
    const s = new Sim({ rounds: [{ ...TRIVIA, eliminateLowest: 5 }, TRIVIA] }).start();
    s.host({ t: 'score.set', id: 'ann', score: 300 }).host({ t: 'score.set', id: 'bob', score: 200 }).host({ t: 'round.end' });
    expect(s.pub.eliminatedNow).toEqual(['cat']);
    s.host({ t: 'round.next' }).host({ t: 'round.begin' }).open();
    expect(s.buzz('cat').status).toBe('excluded');
    s.host({ t: 'player.eliminate', id: 'cat', eliminated: false });
    expect(s.buzz('cat').status).toBe('registered');
  });

  it('crowns the leading team when teams are on', () => {
    const s = new Sim({ rules: { teams: { enabled: true, names: ['Red', 'Blue'] } }, players: ['a1', 'b1', 'a2', 'b2'] }).start();
    s.host({ t: 'score.set', id: 'b1', score: 500 }).host({ t: 'score.set', id: 'a1', score: 300 }).host({ t: 'score.set', id: 'a2', score: 300 });
    s.host({ t: 'game.end' });
    expect(s.pub.champions).toEqual(['a1', 'a2']);
  });
});

describe('pause, undo and recovery', () => {
  it('freezes timers while paused and disarms the buzzers', () => {
    const s = new Sim({ buzzer: { answerSec: 10 } }).start().open();
    s.buzz('ann');
    s.advance(4000);
    s.host({ t: 'pause', paused: true });
    expect(() => s.host({ t: 'judge', correct: true })).toThrow(/Resume/);
    expect(() => s.player('bob', { t: 'select', cat: 0, idx: 1 })).toThrow(GameError);
    s.advance(60_000);
    expect(s.trivia.clue!.answerTimeUp).toBe(false);
    s.host({ t: 'pause', paused: false });
    expect(s.trivia.clue!.timer!.endsAt - s.now).toBe(6000);

    const t = new Sim().start().open();
    t.host({ t: 'pause', paused: true });
    expect(t.buzz('ann').status).toBe('closed');
    t.host({ t: 'pause', paused: false });
    expect(t.trivia.clue!.stage).toBe('reading');
  });

  it('restores a snapshot while keeping the current roster', () => {
    const s = new Sim().start().open(0, 1);
    s.buzz('ann');
    const snapshot = s.state;
    const takenAt = s.now;
    s.host({ t: 'judge', correct: false });
    s.join('dan');
    s.host({ t: 'player.kick', id: 'cat' });
    s.advance(5000);
    s.state = restoreSnapshot(s.state, snapshot, takenAt, s.now);
    expect(s.score('ann')).toBe(0);
    expect(s.state.order).toEqual(['ann', 'bob', 'dan']);
    expect(s.trivia.clue).toMatchObject({ stage: 'answering', answererId: 'ann' });
    // The answer timer keeps the time it had left when the snapshot was taken.
    expect(s.trivia.clue!.timer!.endsAt - s.now).toBe(12_000);
    s.host({ t: 'judge', correct: true });
    expect(s.score('ann')).toBe(200);
  });

  it('comes back from a restart paused, with buzzers disarmed and everyone offline', () => {
    const s = new Sim().start().open();
    s.state = applySystem(s.state, { t: 'presence', id: 'ann', connected: true }, { now: s.now, rand: s.rand, rtt: () => null }).state;
    const savedAt = s.now;
    s.now += 30_000;
    s.state = applySystem(s.state, { t: 'recover', savedAt }, { now: s.now, rand: s.rand, rtt: () => null }).state;
    expect(s.pub.paused).toBe(true);
    expect(s.pub.players.every((p) => !p.connected)).toBe(true);
    s.host({ t: 'pause', paused: false });
    expect(s.trivia.clue!.stage).toBe('reading');
  });

  it('plays again in the same room with scores reset', () => {
    const s = new Sim().start();
    s.host({ t: 'score.set', id: 'ann', score: 900 }).host({ t: 'game.end' });
    const rules = s.state.rules;
    const rounds = assembleRounds(rules, { categories: categories(4), surveys: [] }, undefined, s.rand);
    s.state = applySystem(s.state, { t: 'rematch', rules, rounds, packTitles: ['Again'] }, { now: s.now, rand: s.rand, rtt: () => null }).state;
    expect(s.pub).toMatchObject({ phase: 'lobby', champions: null });
    expect(s.pub.players.map((p) => p.score)).toEqual([0, 0, 0]);
    expect(s.state.stats.ann.correct).toBe(0);
  });
});

describe('assembling rounds', () => {
  const rules = BUILTIN_PRESETS[0].rules;

  it('ships presets that satisfy the rules schema', () => {
    for (const p of BUILTIN_PRESETS) expect(GameRulesSchema.safeParse(p.rules).success).toBe(true);
  });

  it('never reuses a category or survey across rounds, and doubles values', () => {
    const rounds = assembleRounds(rules, { categories: categories(11), surveys: surveys(5) }, undefined, Math.random);
    const titles = rounds.flatMap((r) => (r.mode === 'trivia' ? r.board.map((c) => c.title) : r.mode === 'final' ? [r.category] : []));
    expect(new Set(titles).size).toBe(11);
    expect(rounds[1].mode === 'trivia' && rounds[1].board[0].clues.map((c) => c.value)).toEqual([200, 400, 600, 800, 1000]);
    expect(rounds[0].mode === 'trivia' && rounds[0].board.flatMap((c) => c.clues).filter((c) => c.wager)).toHaveLength(1);
  });

  it('honours explicit picks and reports a shortage clearly', () => {
    const pool = { categories: categories(11), surveys: surveys(5) };
    const rounds = assembleRounds(rules, pool, [['cat7', 'cat3'], null, ['cat0'], null], Math.random);
    expect(rounds[0].mode === 'trivia' && rounds[0].board.slice(0, 2).map((c) => c.title)).toEqual(['Category 7', 'Category 3']);
    expect(rounds[2].mode === 'final' && rounds[2].category).toBe('Category 0');
    expect(() => assembleRounds(rules, { categories: categories(10), surveys: surveys(5) }, undefined, Math.random)).toThrow(/short by 1 category/);
    expect(() => assembleRounds(rules, pool, [['cat1'], ['cat1'], null, null], Math.random)).toThrow(/two rounds/);
  });
});

describe('final round', () => {
  const sim = () => new Sim({ rounds: [FINAL] }).start();

  it('takes wagers, then answers, then reveals trailing players first', () => {
    const s = sim();
    s.host({ t: 'score.set', id: 'ann', score: 3000 }).host({ t: 'score.set', id: 'bob', score: 500 });
    expect(s.final).toMatchObject({ stage: 'wager', question: null });
    expect(s.you('ann').wager!.max).toBe(3000);
    expect(s.you('cat').wager!.max).toBe(1000); // nothing banked: the cap applies
    s.player('ann', { t: 'wager', amount: 2000 }).player('bob', { t: 'wager', amount: 500 });
    expect(s.final.wagered).toEqual(['ann', 'bob']);
    s.player('cat', { t: 'wager', amount: 1000 });
    // Everyone is in, so the question appears without the host doing anything.
    expect(s.final).toMatchObject({ stage: 'answering', question: 'Question 0.4?' });
    s.player('ann', { t: 'final.answer', text: 'the answer 0.4' }).player('bob', { t: 'final.answer', text: 'no idea' });
    expect(JSON.stringify(s.pub)).not.toContain('no idea');
    s.advance(60_000);
    expect(s.final.stage).toBe('reveal');

    s.host({ t: 'final.show' });
    expect(s.final.reveals).toEqual([{ playerId: 'cat', answer: '', wager: null, correct: null, delta: null }]);
    expect(() => s.host({ t: 'final.show' })).toThrow(/Judge/);
    s.host({ t: 'final.judge', correct: false }).host({ t: 'final.show' });
    expect(s.secret.round).toMatchObject({ current: 'bob', suggestion: false });
    s.host({ t: 'final.judge', correct: false }).host({ t: 'final.show' });
    expect(s.secret.round).toMatchObject({ current: 'ann', suggestion: true });
    expect(s.final.answer).toBeNull();
    s.host({ t: 'final.judge', correct: true });
    expect(s.final.answer).toBe('Answer 0.4');
    expect([s.score('ann'), s.score('bob'), s.score('cat')]).toEqual([5000, 0, -1000]);
    s.host({ t: 'round.end' });
    expect(s.pub.champions).toEqual(['ann']);
  });

  it('treats a missing wager as zero when the clock runs out', () => {
    const s = sim();
    s.player('ann', { t: 'wager', amount: 300 });
    s.advance(45_000);
    expect(s.final.stage).toBe('answering');
    expect(s.state.rounds[0].mode === 'final' && s.state.rounds[0].wagers).toEqual({ ann: 300, bob: 0, cat: 0 });
  });
});

describe('extensibility', () => {
  it('runs a full show of three different modes back to back', () => {
    const s = new Sim({ rounds: [TRIVIA, FINAL, FAST_MONEY] }).start();
    s.host({ t: 'round.end' }).host({ t: 'round.next' }).host({ t: 'round.begin' });
    expect(s.pub.round!.mode).toBe('final');
    s.host({ t: 'round.end' }).host({ t: 'round.next' }).host({ t: 'round.begin' });
    expect(s.pub.round!.mode).toBe('fastMoney');
    expect(s.pub.rounds.map((r) => r.mode)).toEqual(['trivia', 'final', 'fastMoney']);
  });
});
