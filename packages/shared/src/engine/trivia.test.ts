import { describe, expect, it } from 'vitest';
import { HostActionSchema, PlayerActionSchema, type PlayerAction } from '../actions';
import { GameError } from './core';
import { nextDeadline } from './game';
import { categories, Sim, surveys, TRIVIA } from './testkit';

describe('buzzer arbitration', () => {
  it('awards the first buzz the server receives and records the ones just behind it', () => {
    const s = new Sim().start().open();
    s.advance(327);
    expect(s.buzz('ann')).toEqual({ status: 'registered', ms: 327 });
    s.advance(28);
    expect(s.buzz('bob')).toEqual({ status: 'registered', ms: 355 });
    s.advance(56);
    s.buzz('cat');

    const clue = s.trivia.clue!;
    expect(clue.stage).toBe('answering');
    expect(clue.answererId).toBe('ann');
    expect(clue.attempts.map((a) => [a.playerId, a.ms, a.deltaMs, a.winner, a.late])).toEqual([
      ['ann', 327, 0, true, false],
      ['bob', 355, 28, false, true],
      ['cat', 411, 84, false, true],
    ]);
  });

  it('breaks an exact tie by arrival order', () => {
    const s = new Sim().start().open();
    s.advance(200);
    s.buzz('bob');
    s.buzz('ann');
    expect(s.trivia.clue!.answererId).toBe('bob');
    expect(s.trivia.clue!.attempts.map((a) => a.deltaMs)).toEqual([0, 0]);
  });

  it('ignores duplicate buzzes without changing state', () => {
    const s = new Sim().start().open();
    s.advance(100);
    s.buzz('ann');
    const seq = s.state.seq;
    expect(s.buzz('ann').status).toBe('duplicate');
    expect(s.state.seq).toBe(seq);
    expect(s.state.stats.ann.buzzes).toBe(1);
  });

  it('rejects buzzes when nothing is in play, and from unknown players', () => {
    const s = new Sim().start();
    expect(s.buzz('ann').status).toBe('closed');
    s.open();
    expect(s.buzz('nobody').status).toBe('closed');
  });

  it('never lets a client influence the recorded time', () => {
    // The only inputs are the player id and the server clock.
    const s = new Sim().start().open();
    s.advance(123.4567);
    expect(s.buzz('ann').ms).toBe(123.457);
  });

  it('tells each player their own buzzer state', () => {
    const s = new Sim().start().host({ t: 'clue.select', cat: 0, idx: 0 });
    expect(s.you('ann').buzzer.state).toBe('open');
    s.advance(50);
    s.buzz('ann');
    s.advance(20);
    s.buzz('bob');
    expect(s.you('ann').buzzer).toMatchObject({ state: 'yours', ms: 50, deltaMs: 0, rank: 1 });
    expect(s.you('bob').buzzer).toMatchObject({ state: 'taken', ms: 70, deltaMs: 20, rank: 2 });
    // Cat has not buzzed: her buzzer stays live for the rest of the grace period, then shuts.
    expect(s.you('cat').buzzer).toMatchObject({ state: 'open', ms: null, rank: null });
    s.advance(300);
    expect(s.you('cat').buzzer).toMatchObject({ state: 'taken', ms: null, rank: null });
  });

  it('keeps the other buzzers live for a grace period after the first buzz, without changing who won', () => {
    const s = new Sim({ buzzer: { graceMs: 250 } }).start().open();
    s.advance(400);
    s.buzz('ann');
    // Ann has the floor at once; nothing waits for the grace period.
    expect(s.trivia.clue).toMatchObject({ stage: 'answering', answererId: 'ann' });
    expect(s.events.at(-1)).toEqual({ type: 'buzz.winner', playerId: 'ann' });
    expect(nextDeadline(s.state)).toBe(s.now + 250);

    s.advance(87);
    expect(s.buzz('bob')).toEqual({ status: 'registered', ms: 487 });
    s.advance(162);
    expect(s.buzz('cat')).toEqual({ status: 'registered', ms: 649 });
    expect(s.trivia.clue!.attempts.map((a) => [a.playerId, a.ms, a.deltaMs, a.winner])).toEqual([
      ['ann', 400, 0, true],
      ['bob', 487, 87, false],
      ['cat', 649, 249, false],
    ]);
    expect(s.trivia.clue!.answererId).toBe('ann');
    expect(s.state.stats.ann.buzzWins).toBe(1);
    expect(s.state.stats.bob.buzzWins).toBe(0);
  });

  it('shuts the buzzers when the grace period ends, and at once when there is none', () => {
    const s = new Sim({ buzzer: { graceMs: 250 }, players: ['ann', 'bob', 'cat', 'dan'] }).start().open();
    s.advance(400);
    s.buzz('ann');
    s.advance(100);
    s.buzz('bob');
    expect(s.you('dan').buzzer.state).toBe('open');
    s.advance(150);
    expect(s.you('dan').buzzer.state).toBe('taken');
    expect(s.buzz('dan').status).toBe('closed');
    expect(s.trivia.clue!.attempts.map((a) => a.playerId)).toEqual(['ann', 'bob']);
    // The answer timer is the only clock left.
    expect(nextDeadline(s.state)).toBe(s.state.rounds[0].mode === 'trivia' ? s.state.rounds[0].clue!.deadline : null);

    const none = new Sim({ buzzer: { graceMs: 0 } }).start().open();
    none.advance(400);
    none.buzz('ann');
    expect(none.you('bob').buzzer.state).toBe('taken');
    expect(none.buzz('bob').status).toBe('closed');
    expect(none.trivia.clue!.attempts).toHaveLength(1);
  });

  it('starts a fresh grace period when the buzzers reopen for a steal, and stops it while paused', () => {
    const s = new Sim({ buzzer: { graceMs: 250 } }).start().open();
    s.advance(400);
    s.buzz('ann');
    s.advance(50);
    s.buzz('bob');
    s.advance(1000);
    s.host({ t: 'judge', correct: false });
    // A new buzz: bob's near miss on the first one does not carry over.
    expect(s.trivia.clue).toMatchObject({ stage: 'open', attempts: [] });
    s.advance(300);
    s.buzz('cat');
    expect(s.you('bob').buzzer.state).toBe('open');
    s.host({ t: 'pause', paused: true });
    s.advance(5000);
    s.host({ t: 'pause', paused: false });
    // The 250 ms picks up where it stopped.
    expect(s.you('bob').buzzer.state).toBe('open');
    s.advance(100);
    expect(s.buzz('bob')).toMatchObject({ status: 'registered' });
    s.advance(150);
    expect(s.you('ann').buzzer.state).toBe('out');
    expect(s.trivia.clue!.attempts.map((a) => a.playerId)).toEqual(['cat', 'bob']);
  });
});

describe('latency-adjusted arbitration', () => {
  const adjusted = { arbitration: 'latencyAdjusted', collectionWindowMs: 100, maxCompensationMs: 150 } as const;

  it('collects buzzes for a window, then ranks by adjusted time', () => {
    const s = new Sim({ buzzer: adjusted }).start().open();
    s.rtts = { ann: 20, bob: 200 };
    s.advance(300);
    s.buzz('ann'); // adjusted 290
    expect(s.trivia.clue!.stage).toBe('open');
    expect(s.trivia.clue!.collecting).toBe(true);
    expect(s.trivia.clue!.attempts).toEqual([]); // nothing is shown until the window closes
    s.advance(40);
    s.buzz('bob'); // raw 340, adjusted 240
    s.advance(60);

    const clue = s.trivia.clue!;
    expect(clue.answererId).toBe('bob');
    expect(clue.attempts.map((a) => [a.playerId, a.ms, a.adjustedMs, a.deltaMs])).toEqual([
      ['bob', 340, 240, 0],
      ['ann', 300, 290, 50],
    ]);
  });

  it('caps the compensation and never produces a negative time', () => {
    const s = new Sim({ buzzer: { ...adjusted, maxCompensationMs: 50 } }).start().open();
    s.rtts = { ann: 5000 };
    s.advance(30);
    s.buzz('ann');
    s.advance(100);
    expect(s.trivia.clue!.attempts[0].adjustedMs).toBe(0);
    const t = new Sim({ buzzer: { ...adjusted, maxCompensationMs: 50 } }).start().open();
    t.rtts = { ann: 5000 };
    t.advance(400);
    t.buzz('ann');
    t.advance(100);
    expect(t.trivia.clue!.attempts[0].adjustedMs).toBe(350);
  });

  it('marks a buzz that arrives after the window as late even if its adjusted time is lower', () => {
    const s = new Sim({ buzzer: adjusted }).start().open();
    s.rtts = { bob: 300 };
    s.advance(300);
    s.buzz('ann');
    s.advance(120); // window closed; ann wins
    expect(s.trivia.clue!.answererId).toBe('ann');
    s.buzz('bob'); // raw 420, adjusted 270
    const bob = s.trivia.clue!.attempts.find((a) => a.playerId === 'bob')!;
    expect(bob).toMatchObject({ late: true, winner: false, deltaMs: -30 });
    expect(s.trivia.clue!.answererId).toBe('ann');
  });
});

describe('removing a player mid-clue', () => {
  it('closes a collection window that the kicked player was the only one in', () => {
    const s = new Sim({ buzzer: { arbitration: 'latencyAdjusted', collectionWindowMs: 100, maxCompensationMs: 150, buzzSec: 0 } }).start().open();
    s.buzz('ann');
    s.host({ t: 'player.kick', id: 'ann' });
    // Nothing is left to wait for, so no deadline may remain in the past.
    expect(nextDeadline(s.state)).toBeNull();
    s.advance(500);
    expect(s.trivia.clue).toMatchObject({ stage: 'open', answererId: null });
    expect(s.buzz('bob').status).toBe('registered');
  });

  it('throws the clue out, scoring included, when the player answering is kicked', () => {
    const s = new Sim().start().open(0, 1);
    s.buzz('ann');
    s.host({ t: 'judge', correct: false });
    s.buzz('bob');
    s.host({ t: 'player.kick', id: 'bob' });
    expect(s.trivia.clue).toBeNull();
    expect(s.trivia.board[0].clues[1]).toMatchObject({ used: false, winnerId: null });
    expect(s.score('ann')).toBe(0);
  });

  it('leaves a clue that is already settled alone', () => {
    const s = new Sim().start().open(0, 1);
    s.buzz('ann');
    s.host({ t: 'judge', correct: true });
    s.host({ t: 'player.kick', id: 'bob' });
    expect(s.trivia.clue!.stage).toBe('result');
    expect(s.trivia.board[0].clues[1].used).toBe(true);
    expect(s.score('ann')).toBe(200);
  });
});

describe('buzzers open by themselves', () => {
  it('lets players buzz the moment a clue is selected, with thirty seconds on the clock by default', () => {
    const s = new Sim().start();
    s.host({ t: 'clue.select', cat: 0, idx: 0 });
    expect(s.trivia.clue).toMatchObject({ stage: 'open', timer: { endsAt: s.now + 30_000, totalMs: 30_000 } });
    expect(s.eventTypes()).toContain('buzz.open');
    expect(s.you('ann').buzzer.state).toBe('open');
    expect(s.buzz('ann')).toEqual({ status: 'registered', ms: 0 });
  });

  it('gives the host no switch for it: arming and disarming are not actions any more', () => {
    for (const t of ['buzz.open', 'buzz.close']) expect(HostActionSchema.safeParse({ t }).success).toBe(false);
    expect(HostActionSchema.safeParse({ t: 'buzz.reset' }).success).toBe(true);
  });

  it('keeps the host’s +10 seconds and stop-clock controls on the question timer', () => {
    const s = new Sim().start().open();
    s.advance(5000);
    s.host({ t: 'timer.extend', sec: 10 });
    expect(s.trivia.clue!.timer).toEqual({ endsAt: s.now + 35_000, totalMs: 40_000 });
    s.host({ t: 'timer.stop' });
    expect(s.trivia.clue!.timer).toBeNull();
    s.advance(120_000);
    expect(s.trivia.clue!.stage).toBe('open');
  });

  it('ends the clue when the thirty seconds run out with nobody in', () => {
    const s = new Sim().start().open();
    s.advance(29_999);
    expect(s.trivia.clue!.stage).toBe('open');
    s.advance(1);
    expect(s.trivia.clue).toMatchObject({ stage: 'result', timedOut: true });
  });
});

describe('hiding the question while an answer is judged', () => {
  const question = 'Question 0.1?';

  it('takes the question off every screen but the host’s the moment someone buzzes in', () => {
    const s = new Sim().start().open(0, 1);
    expect(s.trivia.clue!.question).toBe(question);
    s.advance(4000);
    s.buzz('ann');
    expect(s.trivia.clue).toMatchObject({ stage: 'answering', answererId: 'ann', question: null, media: null });
    // No player's own view carries it either; only the host still has the question and the answer.
    for (const id of ['ann', 'bob', 'cat']) expect(JSON.stringify(s.you(id))).not.toContain('Question');
    expect(s.secret.round).toMatchObject({ clue: { question, answer: 'Answer 0.1' } });
  });

  it('brings it back with the buzzers for everyone but the player who got it wrong', () => {
    const s = new Sim().start().open(0, 1);
    s.advance(4000);
    s.buzz('ann');
    s.advance(9000);
    s.host({ t: 'judge', correct: false });
    expect(s.trivia.clue).toMatchObject({ stage: 'open', question, answererId: null, excluded: ['ann'] });
    expect(s.you('ann').buzzer.state).toBe('out');
    expect(s.you('bob').buzzer.state).toBe('open');
    expect(s.buzz('ann').status).toBe('excluded');

    s.buzz('bob');
    expect(s.trivia.clue).toMatchObject({ stage: 'answering', answererId: 'bob', question: null });
    s.host({ t: 'judge', correct: true });
    expect(s.trivia.clue).toMatchObject({ stage: 'result', question, answer: 'Answer 0.1' });
  });

  it('holds the question timer still while the answer is judged and resumes it where it stopped', () => {
    const s = new Sim().start().open(0, 1);
    s.advance(4000);
    s.buzz('ann');
    // The answer clock is a different clock, thirty seconds of its own; the question's 26 seconds are waiting.
    expect(s.trivia.clue!.timer).toEqual({ endsAt: s.now + 30_000, totalMs: 30_000 });
    s.advance(9000);
    s.host({ t: 'judge', correct: false });
    expect(s.trivia.clue!.timer).toEqual({ endsAt: s.now + 26_000, totalMs: 30_000 });
    s.advance(25_999);
    expect(s.trivia.clue!.stage).toBe('open');
    s.advance(1);
    expect(s.trivia.clue).toMatchObject({ stage: 'result', timedOut: true });
  });

  it('always leaves time for a steal, and leaves a stopped clock stopped', () => {
    const s = new Sim().start().open(0, 1);
    s.advance(29_000);
    s.buzz('ann');
    s.host({ t: 'judge', correct: false });
    expect(s.trivia.clue!.timer).toEqual({ endsAt: s.now + 5000, totalMs: 30_000 });

    const t = new Sim().start().open(0, 1);
    t.host({ t: 'timer.stop' });
    t.buzz('ann');
    t.host({ t: 'judge', correct: false });
    expect(t.trivia.clue).toMatchObject({ stage: 'open', timer: null });
  });

  it('does the same when the host throws a buzz out', () => {
    const s = new Sim().start().open(0, 1);
    s.advance(10_000);
    s.buzz('ann');
    s.advance(5000);
    s.host({ t: 'buzz.reset' });
    expect(s.trivia.clue).toMatchObject({ stage: 'open', question, excluded: [], timer: { endsAt: s.now + 20_000, totalMs: 30_000 } });
  });
});

describe('picking a clue', () => {
  it('is the host’s job alone: a player has no way to ask for one, even with the board', () => {
    const s = new Sim().start();
    const control = s.trivia.controlId!;
    const pick = { t: 'select', cat: 0, idx: 0 };
    expect(PlayerActionSchema.safeParse(pick).success).toBe(false);
    // Even a message that got past validation would do nothing.
    expect(() => s.player(control, pick as unknown as PlayerAction)).toThrow(GameError);
    expect(s.trivia.clue).toBeNull();
    expect(s.you(control)).not.toHaveProperty('canSelect');

    s.host({ t: 'clue.select', cat: 0, idx: 0 });
    expect(s.trivia.clue).toMatchObject({ cat: 0, idx: 0, stage: 'open' });
  });

  it('still shows every player the board and whose pick it is', () => {
    const s = new Sim().start().open(0, 0);
    s.buzz('bob');
    s.host({ t: 'judge', correct: true }).host({ t: 'clue.continue' });
    expect(s.trivia.controlId).toBe('bob');
    expect(s.trivia.board.map((cat) => cat.clues.map((c) => [c.value, c.used]))).toEqual([[[100, true], [200, false]], [[100, false], [200, false]]]);
  });
});

describe('judging and scoring', () => {
  it('scores a correct answer, passes control and marks the clue used', () => {
    const s = new Sim().start().open(1, 1);
    s.buzz('bob');
    s.host({ t: 'judge', correct: true });
    expect(s.score('bob')).toBe(200);
    expect(s.trivia.clue).toMatchObject({ stage: 'result', answer: 'Answer 1.1' });
    expect(s.trivia.controlId).toBe('bob');
    s.host({ t: 'clue.continue' });
    expect(s.trivia.stage).toBe('board');
    expect(s.trivia.board[1].clues[1]).toMatchObject({ used: true, winnerId: 'bob' });
    expect(() => s.host({ t: 'clue.select', cat: 1, idx: 1 })).toThrow(GameError);
  });

  it('deducts for a wrong answer and re-arms for the others only', () => {
    const s = new Sim().start();
    const control = s.trivia.controlId;
    s.open(0, 1);
    s.buzz('ann');
    s.host({ t: 'judge', correct: false });
    expect(s.score('ann')).toBe(-200);
    expect(s.trivia.clue!.stage).toBe('open');
    expect(s.buzz('ann').status).toBe('excluded');
    expect(s.you('ann').buzzer.state).toBe('out');
    s.buzz('bob');
    s.host({ t: 'judge', correct: false });
    s.buzz('cat');
    s.host({ t: 'judge', correct: false });
    // Everyone has missed: the clue ends and control stays where it was.
    expect(s.trivia.clue!.stage).toBe('result');
    expect(s.trivia.controlId).toBe(control);
  });

  it('honours the penalty percentage', () => {
    const s = new Sim({ buzzer: { incorrectPenaltyPct: 50 } }).start().open(0, 1);
    s.buzz('ann');
    s.host({ t: 'judge', correct: false });
    expect(s.score('ann')).toBe(-100);
  });

  it('lets the same player buzz again when rebuzz is on', () => {
    const s = new Sim({ buzzer: { rebuzz: true } }).start().open();
    s.buzz('ann');
    s.host({ t: 'judge', correct: false });
    expect(s.buzz('ann').status).toBe('registered');
    s.host({ t: 'judge', correct: true });
    expect(s.score('ann')).toBe(0);
  });

  it('ends the clue after a wrong answer when steals are off, or the category is single-attempt', () => {
    const noSteal = new Sim({ buzzer: { reopenOnIncorrect: false } }).start().open();
    noSteal.buzz('ann');
    noSteal.host({ t: 'judge', correct: false });
    expect(noSteal.trivia.clue!.stage).toBe('result');

    const pool = { categories: categories(2, 2).map((c) => ({ ...c, singleAttempt: true })), surveys: surveys(1) };
    const single = new Sim({ pool }).start().open();
    single.buzz('ann');
    single.host({ t: 'judge', correct: false });
    expect(single.trivia.clue!.stage).toBe('result');
  });

  it('locks out a whole team after a wrong answer', () => {
    const s = new Sim({ rules: { teams: { enabled: true, names: ['Red', 'Blue'] } }, players: ['a1', 'b1', 'a2', 'b2'] });
    expect(s.pub.teams!.map((t) => t.playerIds)).toEqual([['a1', 'a2'], ['b1', 'b2']]);
    s.start().open();
    s.buzz('a1');
    s.host({ t: 'judge', correct: false });
    expect(s.buzz('a2').status).toBe('excluded');
    expect(s.buzz('b1').status).toBe('registered');
  });

  it('times out when nobody buzzes and when the answer clock runs down', () => {
    const s = new Sim({ buzzer: { buzzSec: 5, answerSec: 3 } }).start().open();
    s.advance(5000);
    expect(s.trivia.clue).toMatchObject({ stage: 'result', timedOut: true });
    s.host({ t: 'clue.continue' }).open(0, 1);
    s.buzz('ann');
    s.advance(3000);
    // The host still decides; the clock only signals that time is up.
    expect(s.trivia.clue).toMatchObject({ stage: 'answering', answerTimeUp: true, timer: null });
    expect(s.eventTypes().filter((t) => t === 'timeup')).toHaveLength(2);
  });

  it('supports reset and cancel for disputes', () => {
    const s = new Sim().start().open(0, 1);
    s.buzz('ann');
    s.host({ t: 'buzz.reset' });
    expect(s.trivia.clue).toMatchObject({ stage: 'open', answererId: null, attempts: [] });
    expect(s.state.stats.ann.buzzWins).toBe(0);
    s.buzz('bob');
    s.host({ t: 'judge', correct: false });
    expect(s.state.stats.bob.incorrect).toBe(1);
    s.host({ t: 'clue.cancel' });
    expect(s.score('bob')).toBe(0);
    expect(s.trivia.board[0].clues[1].used).toBe(false);
    // A ruling on a clue that was thrown out does not count against anyone's record either.
    expect(s.state.stats.bob).toMatchObject({ correct: 0, incorrect: 0 });
  });

  it('finishes the round when the board is cleared', () => {
    const s = new Sim({ rounds: [TRIVIA, TRIVIA] }).start();
    for (const [cat, idx] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      s.open(cat, idx);
      s.buzz('ann');
      s.host({ t: 'judge', correct: true }).host({ t: 'clue.continue' });
    }
    expect(s.pub.phase).toBe('standings');
    expect(s.score('ann')).toBe(600);
    expect(s.pub.stats!.ann).toMatchObject({ buzzWins: 4, correct: 4, incorrect: 0 });
  });
});

describe('wager clues', () => {
  const round = { ...TRIVIA, wagers: 4 };
  const sim = () => {
    // A 2x2 board with wagers allowed only below the top row: both bottom clues are wagers.
    const s = new Sim({ rounds: [round] }).start();
    return s;
  };

  it('places wagers below the top row', () => {
    const s = sim();
    const board = s.secret.round!.mode === 'trivia' ? s.secret.round!.board : [];
    expect(board.map((cat) => cat.map((c) => c.wager))).toEqual([[false, true], [false, true]]);
  });

  it('takes a blind wager from the player in control, then pays or charges it in full', () => {
    const s = sim();
    const control = s.trivia.controlId!;
    const other = ['ann', 'bob', 'cat'].find((p) => p !== control)!;
    s.host({ t: 'clue.select', cat: 0, idx: 1 });
    expect(s.trivia.clue).toMatchObject({ stage: 'wager', question: null, isWager: true });
    expect(s.you(control).wager).toEqual({ min: 0, max: 1000, amount: null });
    expect(() => s.player(other, { t: 'wager', amount: 100 })).toThrow(/not yours/);
    expect(() => s.player(control, { t: 'wager', amount: 1001 })).toThrow(GameError);
    s.player(control, { t: 'wager', amount: 800 });
    // A wager is answered alone, so its question stays up while it is answered.
    expect(s.trivia.clue).toMatchObject({ stage: 'answering', answererId: control, question: 'Question 0.1?' });
    expect(s.buzz(other).status).toBe('closed');
    s.host({ t: 'judge', correct: false });
    expect(s.score(control)).toBe(-800);
    expect(s.trivia.clue!.stage).toBe('result');
    // Kicking the player afterwards must not put the settled clue back in play.
    s.host({ t: 'player.kick', id: control });
    expect(s.trivia.board[0].clues[1].used).toBe(true);
  });

  it('lets a rich player wager their whole score', () => {
    const s = sim();
    const control = s.trivia.controlId!;
    s.host({ t: 'score.set', id: control, score: 4000 }).host({ t: 'clue.select', cat: 0, idx: 1 });
    expect(s.you(control).wager!.max).toBe(4000);
    s.host({ t: 'wager.set', amount: 4000 }).host({ t: 'judge', correct: true });
    expect(s.score(control)).toBe(8000);
  });
});

describe('secrecy', () => {
  it('never puts an unrevealed answer in the public or player views', () => {
    const s = new Sim().start().open();
    const leaks = () => JSON.stringify([s.pub, s.you('ann')]).includes('Answer');
    expect(leaks()).toBe(false);
    s.buzz('ann');
    expect(leaks()).toBe(false);
    expect(JSON.stringify(s.secret)).toContain('Answer 0.0');
    s.host({ t: 'judge', correct: true });
    expect(s.trivia.clue!.answer).toBe('Answer 0.0');
    // Only the clue just played is revealed.
    expect(JSON.stringify(s.pub)).not.toContain('Answer 0.1');
  });
});
