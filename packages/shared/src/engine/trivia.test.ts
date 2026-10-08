import { describe, expect, it } from 'vitest';
import { GameError } from './core';
import { categories, Sim, surveys, TRIVIA } from './testkit';

describe('buzzer arbitration', () => {
  it('awards the first buzz the server receives and records the rest as late', () => {
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
    expect(s.you('ann').buzzer.state).toBe('wait');
    s.host({ t: 'buzz.open' });
    expect(s.you('ann').buzzer.state).toBe('open');
    s.advance(50);
    s.buzz('ann');
    s.advance(20);
    s.buzz('bob');
    expect(s.you('ann').buzzer).toMatchObject({ state: 'yours', ms: 50, deltaMs: 0, rank: 1 });
    expect(s.you('bob').buzzer).toMatchObject({ state: 'taken', ms: 70, deltaMs: 20, rank: 2 });
    expect(s.you('cat').buzzer).toMatchObject({ state: 'taken', ms: null, rank: null });
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

describe('early buzzing', () => {
  it('locks out an early buzzer for the configured time after their last early press', () => {
    const s = new Sim({ buzzer: { earlyBuzz: 'lockout', earlyLockoutMs: 250 } }).start().host({ t: 'clue.select', cat: 0, idx: 0 });
    expect(s.buzz('ann').status).toBe('early');
    s.advance(100);
    s.host({ t: 'buzz.open' });
    expect(s.you('ann').buzzer.until).toBe(s.now + 150);
    s.advance(100);
    expect(s.buzz('ann').status).toBe('lockedOut');
    s.advance(60);
    expect(s.buzz('ann').status).toBe('registered');
    expect(s.state.stats.ann.earlyBuzzes).toBe(1);
  });

  it('can be ignored entirely', () => {
    const s = new Sim({ buzzer: { earlyBuzz: 'ignore' } }).start().host({ t: 'clue.select', cat: 0, idx: 0 });
    const seq = s.state.seq;
    expect(s.buzz('ann').status).toBe('early');
    expect(s.state.seq).toBe(seq);
    s.host({ t: 'buzz.open' });
    expect(s.buzz('ann').status).toBe('registered');
  });

  it('charges the penalty once per clue', () => {
    const s = new Sim({ buzzer: { earlyBuzz: 'penalty', earlyPenalty: 50, earlyLockoutMs: 0 } }).start().host({ t: 'clue.select', cat: 0, idx: 0 });
    s.buzz('ann');
    s.buzz('ann');
    expect(s.score('ann')).toBe(-50);
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

  it('supports reset, close and cancel for disputes', () => {
    const s = new Sim().start().open(0, 1);
    s.buzz('ann');
    s.host({ t: 'buzz.reset' });
    expect(s.trivia.clue).toMatchObject({ stage: 'open', answererId: null, attempts: [] });
    expect(s.state.stats.ann.buzzWins).toBe(0);
    s.host({ t: 'buzz.close' });
    expect(s.trivia.clue!.stage).toBe('reading');
    s.host({ t: 'buzz.open' });
    s.buzz('bob');
    s.host({ t: 'judge', correct: false });
    s.host({ t: 'clue.cancel' });
    expect(s.score('bob')).toBe(0);
    expect(s.trivia.board[0].clues[1].used).toBe(false);
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
    expect(s.trivia.clue).toMatchObject({ stage: 'answering', answererId: control, question: 'Question 0.1?' });
    expect(s.buzz(other).status).toBe('closed');
    s.host({ t: 'judge', correct: false });
    expect(s.score(control)).toBe(-800);
    expect(s.trivia.clue!.stage).toBe('result');
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
