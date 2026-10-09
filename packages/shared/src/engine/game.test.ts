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

  it('will not start until every player whose phone is connected has tapped ready', () => {
    const s = new Sim({ players: [] });
    const online = (id: string) => (s.state = applySystem(s.state, { t: 'presence', id, connected: true }, { now: s.now, rand: s.rand, rtt: () => null }).state);
    for (const name of ['Ann', 'Bob', 'Cat']) {
      s.join(name, false);
      online(name);
    }
    expect(() => s.host({ t: 'start' })).toThrow('Waiting for Ann, Bob, and Cat to tap ready');
    s.player('Ann', { t: 'ready', ready: true }).player('Bob', { t: 'ready', ready: true });
    expect(() => s.host({ t: 'start' })).toThrow('Waiting for Cat to tap ready');
    expect(s.pub.phase).toBe('lobby');

    // Changing your mind counts: un-readying holds the show again.
    s.player('Cat', { t: 'ready', ready: true }).player('Ann', { t: 'ready', ready: false });
    expect(() => s.host({ t: 'start' })).toThrow('Waiting for Ann to tap ready');
    s.player('Ann', { t: 'ready', ready: true });
    s.host({ t: 'start' });
    expect(s.pub.phase).toBe('round');
  });

  it('does not let a phone that has dropped out hold the room up, but needs somebody ready', () => {
    const s = new Sim({ players: [] });
    s.join('Ann', false);
    s.join('Bob', false);
    // Nobody is connected, so nobody is being waited on; but nobody has said they are ready either.
    expect(() => s.host({ t: 'start' })).toThrow('Nobody has tapped ready yet');
    s.player('Ann', { t: 'ready', ready: true });
    s.host({ t: 'start' });
    expect(s.pub.phase).toBe('round');
  });

  it('asks everyone to ready up again for a rematch', () => {
    const s = new Sim({ players: ['Ann'] }).start();
    s.host({ t: 'game.end' });
    s.state = applySystem(s.state, { t: 'presence', id: 'Ann', connected: true }, { now: s.now, rand: s.rand, rtt: () => null }).state;
    s.state = applySystem(s.state, { t: 'rematch', rules: s.state.rules, rounds: s.state.rounds, packTitles: [] }, { now: s.now, rand: s.rand, rtt: () => null }).state;
    expect(s.pub.players[0].ready).toBe(false);
    expect(() => s.host({ t: 'start' })).toThrow('Waiting for Ann to tap ready');
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

  it('does not crown a team with nobody on it', () => {
    const s = new Sim({ rules: { teams: { enabled: true, names: ['Red', 'Blue'] } }, players: ['ann'] }).start();
    s.host({ t: 'score.set', id: 'ann', score: -100 }).host({ t: 'game.end' });
    expect(s.pub.champions).toEqual(['ann']);
  });
});

describe('changing a category before its round begins', () => {
  const pool = categories(8);
  const reroll = (s: Sim, cat: number, from = pool) => {
    const out = applySystem(s.state, { t: 'reroll', cat, categories: from }, { now: s.now, rand: s.rand, rtt: () => null });
    s.state = out.state;
    return out.events;
  };
  const titles = (s: Sim) => s.trivia.board.map((c) => c.title);

  it('swaps the one category for another the game is not using, and leaves the rest alone', () => {
    const s = new Sim({ rounds: [{ ...TRIVIA, categories: 3, wagers: 2 }, TRIVIA, FINAL] }).host({ t: 'start' });
    expect(s.trivia.stage).toBe('intro');
    const before = s.state.rounds;
    const wagers = (r: (typeof before)[number]) => (r.mode === 'trivia' ? r.board.flatMap((c) => c.clues).filter((c) => c.wager).length : 0);

    for (let i = 0; i < 12; i++) {
      const was = titles(s);
      expect(reroll(s, 1)).toEqual([{ type: 'category.changed', cat: 1 }]);
      const now = titles(s);
      expect([now[0], now[2]]).toEqual([was[0], was[2]]);
      expect(now[1]).not.toBe(was[1]);
      // Nothing is dealt twice: not on this board, not on the board to come, not in the final.
      const dealt = s.state.rounds.flatMap((r) => (r.mode === 'trivia' ? r.board.map((c) => c.title) : r.mode === 'final' ? [r.category] : []));
      expect(new Set(dealt).size).toBe(dealt.length);
      // The hidden wagers are still there, and the later rounds are as they were.
      expect(wagers(s.state.rounds[0])).toBe(2);
      expect(s.state.rounds.slice(1)).toEqual(before.slice(1));
    }
    const column = s.state.rounds[0].mode === 'trivia' ? s.state.rounds[0].board[1] : null;
    expect(column!.clues.map((c) => c.value)).toEqual([100, 200]);
  });

  it('changes the category of the written final, and its question with it', () => {
    const s = new Sim({ rounds: [FINAL] }).host({ t: 'start' });
    const was = s.final.category;
    reroll(s, 0);
    expect(s.final.category).not.toBe(was);
    const round = s.state.rounds[0];
    const source = pool.find((c) => c.title === s.final.category)!;
    expect(round.mode === 'final' && round.clue.question).toBe(source.clues.at(-1)!.question);
    expect(() => reroll(s, 1)).toThrow(/only one category/);
  });

  it('is refused once the round has begun, for a round with no categories, and when the packs have nothing left', () => {
    const s = new Sim().host({ t: 'start' });
    expect(() => reroll(s, 5)).toThrow(/not on this board/);
    // Only the two categories already on the board to choose from.
    expect(() => reroll(s, 0, pool.slice(0, 2))).toThrow(/already in play/);
    s.host({ t: 'round.begin' });
    expect(() => reroll(s, 0)).toThrow(/while its round is being introduced/);

    const lobby = new Sim();
    expect(() => reroll(lobby, 0)).toThrow(/while its round is being introduced/);
    const survey = new Sim({ rounds: [FAST_MONEY] }).host({ t: 'start' });
    expect(() => reroll(survey, 0)).toThrow(/while its round is being introduced/);
  });
});

describe('pause, undo and recovery', () => {
  it('freezes timers while paused, and shuts the buzzers until play resumes', () => {
    const s = new Sim({ buzzer: { answerSec: 10 } }).start().open();
    s.buzz('ann');
    s.advance(4000);
    s.host({ t: 'pause', paused: true });
    expect(() => s.host({ t: 'judge', correct: true })).toThrow(/Resume/);
    expect(() => s.player('bob', { t: 'wager', amount: 0 })).toThrow(/paused/);
    s.advance(60_000);
    expect(s.trivia.clue!.answerTimeUp).toBe(false);
    s.host({ t: 'pause', paused: false });
    expect(s.trivia.clue!.timer!.endsAt - s.now).toBe(6000);

    const t = new Sim().start().open();
    t.advance(20_000);
    t.host({ t: 'pause', paused: true });
    expect(t.buzz('ann').status).toBe('closed');
    expect(t.you('ann').buzzer.state).toBe('hidden');
    t.advance(60_000);
    // Resuming opens them again by itself, as a fresh buzz, with the question timer where it stopped.
    t.host({ t: 'pause', paused: false });
    expect(t.trivia.clue).toMatchObject({ stage: 'open', timer: { endsAt: t.now + 10_000, totalMs: 30_000 } });
    t.advance(40);
    expect(t.buzz('ann')).toEqual({ status: 'registered', ms: 40 });
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
    expect(s.trivia.clue!.timer!.endsAt - s.now).toBe(30_000);
    s.host({ t: 'judge', correct: true });
    expect(s.score('ann')).toBe(200);
  });

  it('keeps a paused game paused, and a running game running, through an undo', () => {
    const s = new Sim({ buzzer: { answerSec: 10 } }).start().open();
    s.buzz('ann');
    const snapshot = s.state;
    const takenAt = s.now;
    s.host({ t: 'judge', correct: false });
    s.host({ t: 'pause', paused: true });
    s.advance(3000);
    s.state = restoreSnapshot(s.state, snapshot, takenAt, s.now);
    expect(s.pub).toMatchObject({ paused: true, pausedAt: s.now });
    s.advance(60_000);
    expect(s.trivia.clue!.answerTimeUp).toBe(false);
    s.host({ t: 'pause', paused: false });
    expect(s.trivia.clue!.timer!.endsAt - s.now).toBe(10_000);

    // The other way round: a snapshot taken while paused does not re-pause a running game.
    const t = new Sim().start().open();
    t.host({ t: 'pause', paused: true });
    const paused = t.state;
    t.host({ t: 'pause', paused: false });
    t.state = restoreSnapshot(t.state, paused, t.now, t.now);
    expect(t.pub).toMatchObject({ paused: false, pausedAt: null });
  });

  it('lets the host turn the background music off, and an undo leaves that choice alone', () => {
    const s = new Sim().start().open();
    expect(s.pub.music).toBe(true);
    const snapshot = s.state;
    s.host({ t: 'music', on: false });
    expect(s.pub.music).toBe(false);
    s.state = restoreSnapshot(s.state, snapshot, s.now, s.now);
    expect(s.pub.music).toBe(false);
    // A game saved before the setting existed has music.
    s.state = { ...s.state, music: undefined };
    expect(s.pub.music).toBe(true);
  });

  it('comes back from a restart paused, with buzzers shut and everyone offline', () => {
    const s = new Sim().start().open();
    s.state = applySystem(s.state, { t: 'presence', id: 'ann', connected: true }, { now: s.now, rand: s.rand, rtt: () => null }).state;
    const savedAt = s.now;
    s.now += 30_000;
    s.state = applySystem(s.state, { t: 'recover', savedAt }, { now: s.now, rand: s.rand, rtt: () => null }).state;
    expect(s.pub.paused).toBe(true);
    expect(s.pub.players.every((p) => !p.connected)).toBe(true);
    expect(s.trivia.clue!.stage).toBe('reading');
    expect(s.buzz('ann').status).toBe('closed');
    s.host({ t: 'pause', paused: false });
    expect(s.trivia.clue!.stage).toBe('open');
    expect(s.buzz('ann').status).toBe('registered');
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
