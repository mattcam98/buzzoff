/**
 * Final: one written-answer question that every active player wagers on.
 *
 *   wager ──all in / time──▶ answering ──time / host──▶ reveal (one player at a time, host judges)
 *
 * It doubles as proof that a third mode slots in beside trivia and Fast Money
 * without touching either of them.
 */
import { sameAnswer } from '../normalize';
import type { FinalRound, GameState } from '../state';
import type { FinalPublic, FinalSecret } from '../views';
import { activePlayers, addScore, fail, maxWager, ranked, requirePlayer, setTimer, shiftTime, timerView, type Ctx, type Mode } from './core';

function toAnswering(r: FinalRound, ctx: Ctx): void {
  for (const id of r.players) r.wagers[id] ??= 0;
  r.stage = 'answering';
  setTimer(r, r.def.answerSec, ctx.now);
  ctx.events.push({ type: 'final.stage', stage: 'answering' });
}

function toReveal(g: GameState, r: FinalRound, ctx: Ctx): void {
  r.stage = 'reveal';
  r.deadline = null;
  r.timerMs = null;
  // Trailing players are revealed first so the lead is settled last.
  r.order = ranked(r.players.map((id) => g.players[id]).filter(Boolean)).reverse().map((p) => p.id);
  r.shown = 0;
  ctx.events.push({ type: 'final.stage', stage: 'reveal' });
}

const current = (r: FinalRound) => (r.stage === 'reveal' && r.shown > 0 ? r.order[r.shown - 1] : null);

export const final: Mode<FinalRound, FinalPublic, FinalSecret> = {
  begin(g, r, ctx) {
    r.players = activePlayers(g).map((p) => p.id);
    if (!r.players.length) fail('no_players', 'There is nobody left to play this round');
    r.wagers = {};
    r.answers = {};
    r.results = {};
    r.stage = 'wager';
    setTimer(r, r.def.wagerSec, ctx.now);
    ctx.events.push({ type: 'final.stage', stage: 'wager' });
  },

  host(g, r, a, ctx) {
    switch (a.t) {
      case 'final.advance':
        if (r.stage === 'wager') toAnswering(r, ctx);
        else if (r.stage === 'answering') toReveal(g, r, ctx);
        else fail('bad_stage', 'Nothing to move on from');
        return true;
      case 'final.show': {
        if (r.stage !== 'reveal') fail('bad_stage', 'Answers are not being revealed yet');
        const cur = current(r);
        if (cur && !r.results[cur]) fail('bad_stage', 'Judge the answer on screen first');
        if (r.shown >= r.order.length) fail('reveal_done', 'Every answer has been revealed');
        r.shown += 1;
        ctx.events.push({ type: 'final.shown', playerId: r.order[r.shown - 1] });
        return true;
      }
      case 'final.judge': {
        const cur = current(r) ?? fail('bad_stage', 'No answer is on screen');
        if (r.results[cur]) fail('bad_stage', 'That answer has already been judged');
        const delta = (a.correct ? 1 : -1) * (r.wagers[cur] ?? 0);
        r.results[cur] = { correct: a.correct, delta };
        addScore(g, cur, delta);
        if (g.stats[cur]) g.stats[cur][a.correct ? 'correct' : 'incorrect'] += 1;
        ctx.events.push({ type: 'judged', playerId: cur, correct: a.correct, delta });
        return true;
      }
      default:
        return false;
    }
  },

  player(g, r, playerId, a, ctx) {
    if (!r.players.includes(playerId)) return false;
    switch (a.t) {
      case 'wager': {
        if (r.stage !== 'wager') fail('bad_stage', 'Wagers are closed');
        const max = maxWager(requirePlayer(g, playerId).score, r.def.wagerCap);
        if (a.amount > max) fail('bad_wager', `Wager between 0 and ${max}`);
        r.wagers[playerId] = a.amount;
        if (r.players.every((id) => r.wagers[id] !== undefined)) toAnswering(r, ctx);
        return true;
      }
      case 'final.answer':
        if (r.stage !== 'answering') fail('bad_stage', 'Answers are closed');
        r.answers[playerId] = a.text;
        return true;
      default:
        return false;
    }
  },

  tick(g, r, ctx) {
    if (r.deadline === null || ctx.now < r.deadline) return;
    if (r.stage === 'wager') toAnswering(r, ctx);
    else if (r.stage === 'answering') {
      ctx.events.push({ type: 'timeup', what: 'turn' });
      toReveal(g, r, ctx);
    }
  },

  deadlines: (r) => [r.deadline],
  timer: (r) => r,
  shift(r, delta) {
    r.deadline = shiftTime(r.deadline, delta);
  },
  interrupt() {},

  playerRemoved(_g, r, playerId) {
    if (r.stage === 'reveal') {
      const i = r.order.indexOf(playerId);
      if (i >= 0 && !r.results[playerId]) {
        r.order.splice(i, 1);
        if (i < r.shown) r.shown -= 1;
      }
    }
    r.players = r.players.filter((id) => id !== playerId);
  },

  publicView(_g, r) {
    const started = r.stage === 'answering' || r.stage === 'reveal' || r.stage === 'done';
    const allJudged = r.stage === 'done' || (r.stage === 'reveal' && r.order.every((id) => r.results[id]));
    return {
      mode: 'final',
      title: r.def.title,
      stage: r.stage,
      category: r.category,
      question: started ? r.clue.question : null,
      media: started ? (r.clue.media ?? null) : null,
      answer: allJudged ? r.clue.answer : null,
      timer: timerView(r),
      players: r.players,
      wagered: r.players.filter((id) => r.wagers[id] !== undefined),
      answered: r.players.filter((id) => r.answers[id]),
      reveals: r.order.slice(0, r.stage === 'reveal' || r.stage === 'done' ? r.shown : 0).map((id) => {
        const result = r.results[id];
        return {
          playerId: id,
          answer: r.answers[id] ?? '',
          // The wager is the second beat of each reveal: it appears with the verdict.
          wager: result ? (r.wagers[id] ?? 0) : null,
          correct: result?.correct ?? null,
          delta: result?.delta ?? null,
        };
      }),
      remaining: r.stage === 'reveal' ? r.order.length - r.shown : 0,
    };
  },

  hostView(_g, r) {
    const cur = current(r);
    const typed = cur ? (r.answers[cur] ?? '') : '';
    return {
      mode: 'final',
      question: r.clue.question,
      answer: r.clue.answer,
      accept: r.clue.accept,
      notes: r.clue.notes ?? null,
      wagers: r.wagers,
      answers: r.answers,
      suggestion: cur && !r.results[cur] ? [r.clue.answer, ...r.clue.accept].some((x) => sameAnswer(x, typed)) : null,
      current: cur,
    };
  },

  playerView(g, r, playerId) {
    if (!r.players.includes(playerId)) return {};
    const player = g.players[playerId];
    return {
      wager:
        r.stage === 'wager' && player
          ? { min: 0, max: maxWager(player.score, r.def.wagerCap), amount: r.wagers[playerId] ?? null }
          : null,
      final: r.stage === 'intro' || r.stage === 'wager' ? null : { answer: r.answers[playerId] ?? null, canAnswer: r.stage === 'answering' },
    };
  },
};
