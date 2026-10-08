/**
 * Fast Money: survey questions answered against the clock, then revealed.
 *
 *   ready ──start──▶ answering ──time/all done──▶ (next turn: ready) … ──▶ reveal ──▶ result
 *
 * A "turn" is the set of players answering together: one contestant at a time
 * in the classic finale, or every player at once in the party variant. When
 * `reveal` is `afterEachTurn` the reveal happens between turns instead.
 */
import type { PlayerAction } from '../actions';
import type { Survey } from '../content';
import { matchSurvey, sameAnswer } from '../normalize';
import type { FastMoneyRound, FmOutcome, FmResponse, GameState } from '../state';
import type { FastMoneyPublic, FastMoneySecret, FmCellView } from '../views';
import { activePlayers, addScore, fail, ranked, setTimer, shiftTime, timerView, type Ctx, type Mode } from './core';

const emptyResponse = (): FmResponse => ({ text: '', match: null, points: 0, matchedBy: null });

/** The order in which (turn, question) cells are revealed. */
function fmCells(r: FastMoneyRound): { turn: number; q: number }[] {
  const cells: { turn: number; q: number }[] = [];
  const turns = r.turns.length;
  const questions = r.surveys.length;
  if (r.def.reveal === 'atEnd') {
    for (let q = 0; q < questions; q++) for (let turn = 0; turn < turns; turn++) cells.push({ turn, q });
  } else {
    for (let turn = 0; turn < turns; turn++) for (let q = 0; q < questions; q++) cells.push({ turn, q });
  }
  return cells;
}

/** Turns whose answers are complete and may therefore be revealed. */
const answeredTurns = (r: FastMoneyRound) => (r.stage === 'reveal' || r.stage === 'result' || r.stage === 'done' ? r.turn + 1 : r.turn);

function revealLimit(r: FastMoneyRound): number {
  const done = answeredTurns(r);
  if (r.def.reveal === 'atEnd') return done === r.turns.length ? fmCells(r).length * 2 : 0;
  return done * r.surveys.length * 2;
}

/** 0 = hidden, 1 = answer showing, 2 = answer and points showing. */
function cellStep(r: FastMoneyRound, cells: { turn: number; q: number }[], turn: number, q: number): 0 | 1 | 2 {
  const i = cells.findIndex((c) => c.turn === turn && c.q === q);
  return Math.max(0, Math.min(2, r.revealStep - i * 2)) as 0 | 1 | 2;
}

const turnOf = (r: FastMoneyRound, playerId: string) => r.turns.findIndex((t) => t.includes(playerId));

function score(survey: Survey, text: string): FmResponse {
  if (!text) return emptyResponse();
  const m = matchSurvey(text, survey.answers);
  return m ? { text, match: m.index, points: survey.answers[m.index].points, matchedBy: m.kind } : { text, match: null, points: 0, matchedBy: null };
}

function isDuplicate(r: FastMoneyRound, turn: number, q: number, candidate: FmResponse): boolean {
  return r.turns.slice(0, turn).some((group) =>
    group.some((id) => {
      const earlier = r.responses[id]?.[q];
      if (!earlier?.text) return false;
      return (candidate.match !== null && candidate.match === earlier.match) || sameAnswer(candidate.text, earlier.text);
    }),
  );
}

/** Award (or correct) points for one already-revealed cell. */
function credit(g: GameState, r: FastMoneyRound, playerId: string, points: number): void {
  if (!points) return;
  g.stats[playerId].surveyPoints += points;
  if (r.def.stakes === 'points') addScore(g, playerId, points * r.def.pointMultiplier);
}

function endTurn(r: FastMoneyRound, ctx: Ctx): void {
  r.deadline = null;
  r.timerMs = null;
  r.finished = [];
  const last = r.turn === r.turns.length - 1;
  if (r.def.reveal === 'atEnd' && !last) {
    r.turn += 1;
    r.stage = 'ready';
    ctx.events.push({ type: 'fm.turn', turn: r.turn });
  } else {
    r.stage = 'reveal';
  }
}

function conclude(g: GameState, r: FastMoneyRound, ctx: Ctx): void {
  const players = r.turns.flat();
  const totals: Record<string, number> = {};
  for (const id of players) totals[id] = (r.responses[id] ?? []).reduce((n, x) => n + x.points, 0);
  const combined = players.reduce((n, id) => n + totals[id], 0);
  const outcome: FmOutcome = { totals, combined, winners: [], targetHit: null, bonus: 0 };

  if (r.def.stakes === 'decider') {
    // Highest survey total takes the game; board scores only break a tie.
    const best = Math.max(...players.map((id) => totals[id]));
    const tied = players.filter((id) => totals[id] === best && g.players[id]);
    const topScore = Math.max(...tied.map((id) => g.players[id].score));
    outcome.winners = tied.filter((id) => g.players[id].score === topScore);
    if (outcome.winners.length) g.champions = outcome.winners;
  } else if (r.def.target > 0) {
    // Solo and duo finales chase the target together; in the everybody-plays variant it is per player.
    const shared = r.def.participants !== 'all';
    outcome.winners = shared ? (combined >= r.def.target ? players : []) : players.filter((id) => totals[id] >= r.def.target);
    outcome.targetHit = outcome.winners.length > 0;
    outcome.bonus = r.def.targetBonus;
    for (const id of outcome.winners) addScore(g, id, r.def.targetBonus);
  }
  r.outcome = outcome;
  r.stage = 'result';
  ctx.events.push({ type: 'fm.result', won: outcome.winners.length > 0 });
}

function answer(r: FastMoneyRound, playerId: string, a: Extract<PlayerAction, { t: 'fm.answer' }>): void {
  if (r.stage !== 'answering') fail('bad_stage', 'Time is up');
  if (!r.turns[r.turn].includes(playerId)) fail('not_yours', 'It is not your turn');
  if (r.finished.includes(playerId)) fail('bad_stage', 'You have already locked in your answers');
  const survey = r.surveys[a.q] ?? fail('bad_question', 'No such question');
  const response = score(survey, a.text);
  if (response.text && r.def.blockDuplicates && isDuplicate(r, r.turn, a.q, response)) {
    fail('duplicate', 'Already taken — try another answer!');
  }
  r.responses[playerId][a.q] = response;
}

export const fastMoney: Mode<FastMoneyRound, FastMoneyPublic, FastMoneySecret> = {
  begin(g, r, ctx) {
    const pool = ranked(activePlayers(g));
    if (!pool.length) fail('no_players', 'There is nobody left to play this round');
    if (r.def.participants === 'all') r.turns = [pool.map((p) => p.id)];
    else r.turns = pool.slice(0, r.def.participants === 'top2' ? 2 : 1).map((p) => [p.id]);
    r.responses = {};
    for (const id of r.turns.flat()) r.responses[id] = r.surveys.map(emptyResponse);
    r.turn = 0;
    r.revealStep = 0;
    r.finished = [];
    r.outcome = null;
    r.stage = 'ready';
    ctx.events.push({ type: 'fm.turn', turn: 0 });
  },

  host(g, r, a, ctx) {
    switch (a.t) {
      case 'fm.start':
        if (r.stage !== 'ready') fail('bad_stage', 'The turn has already started');
        r.stage = 'answering';
        setTimer(r, r.def.turnSec + r.def.extraSecPerTurn * r.turn, ctx.now);
        return true;
      case 'fm.endTurn':
        if (r.stage !== 'answering') fail('bad_stage', 'Nobody is answering');
        endTurn(r, ctx);
        return true;
      case 'fm.setAnswer':
      case 'fm.override': {
        if (r.stage === 'intro' || r.stage === 'result' || r.stage === 'done') fail('bad_stage', 'Answers can no longer be changed');
        const list = r.responses[a.playerId] ?? fail('no_player', 'That player is not in this round');
        const survey = r.surveys[a.q] ?? fail('bad_question', 'No such question');
        const before = list[a.q];
        const shown = cellStep(r, fmCells(r), turnOf(r, a.playerId), a.q);
        let next: FmResponse;
        if (a.t === 'fm.setAnswer') {
          if (shown > 0) fail('bad_stage', 'That answer has already been revealed');
          next = score(survey, a.text);
        } else {
          if (a.match !== null && !survey.answers[a.match]) fail('bad_match', 'No such survey answer');
          next = { ...before, match: a.match, points: a.match === null ? 0 : survey.answers[a.match].points, matchedBy: 'host' };
        }
        list[a.q] = next;
        // If the points are already on screen, correct the running score too.
        if (shown === 2) credit(g, r, a.playerId, next.points - before.points);
        return true;
      }
      case 'fm.reveal': {
        if (r.stage !== 'reveal') fail('bad_stage', 'Nothing to reveal yet');
        if (r.revealStep >= revealLimit(r)) fail('reveal_done', 'Everything has been revealed');
        const cell = fmCells(r)[Math.floor(r.revealStep / 2)];
        const group = r.turns[cell.turn];
        r.revealStep += 1;
        if (r.revealStep % 2 === 0) {
          for (const id of group) credit(g, r, id, r.responses[id]?.[cell.q].points ?? 0);
          ctx.events.push({ type: 'fm.reveal', kind: 'points', points: Math.max(0, ...group.map((id) => r.responses[id]?.[cell.q].points ?? 0)) });
        } else {
          ctx.events.push({ type: 'fm.reveal', kind: 'answer' });
        }
        return true;
      }
      case 'fm.next':
        if (r.stage !== 'reveal' || r.revealStep < revealLimit(r)) fail('bad_stage', 'Finish the reveals first');
        if (r.turn < r.turns.length - 1) {
          r.turn += 1;
          r.stage = 'ready';
          ctx.events.push({ type: 'fm.turn', turn: r.turn });
        } else {
          conclude(g, r, ctx);
        }
        return true;
      default:
        return false;
    }
  },

  player(_g, r, playerId, a, ctx) {
    switch (a.t) {
      case 'fm.answer':
        answer(r, playerId, a);
        return true;
      case 'fm.done':
        if (r.stage !== 'answering' || !r.turns[r.turn].includes(playerId)) fail('not_yours', 'It is not your turn');
        if (!r.finished.includes(playerId)) r.finished.push(playerId);
        if (r.turns[r.turn].every((id) => r.finished.includes(id))) endTurn(r, ctx);
        return true;
      default:
        return false;
    }
  },

  tick(_g, r, ctx) {
    if (r.stage === 'answering' && r.deadline !== null && ctx.now >= r.deadline) {
      ctx.events.push({ type: 'timeup', what: 'turn' });
      endTurn(r, ctx);
    }
  },

  deadlines: (r) => [r.deadline],
  timer: (r) => r,
  shift(r, delta) {
    r.deadline = shiftTime(r.deadline, delta);
  },
  interrupt() {},
  resume() {},

  playerRemoved(_g, r, playerId) {
    // Turn slots are kept (possibly empty) so the reveal order never shifts.
    r.turns = r.turns.map((group) => group.filter((id) => id !== playerId));
    r.finished = r.finished.filter((id) => id !== playerId);
    delete r.responses[playerId];
  },

  publicView(_g, r) {
    const cells = fmCells(r);
    const covered = r.def.reveal === 'afterEachTurn' && r.def.blockDuplicates && r.turn > 0 && (r.stage === 'ready' || r.stage === 'answering');
    const view: Record<string, FmCellView[]> = {};
    const totals: Record<string, number> = {};
    const progress: FastMoneyPublic['progress'] = {};
    r.turns.forEach((group, turn) => {
      for (const id of group) {
        const list = r.responses[id] ?? [];
        totals[id] = 0;
        view[id] = list.map((resp, q) => {
          const step = cellStep(r, cells, turn, q);
          if (step === 2) totals[id] += resp.points;
          return { text: step >= 1 ? resp.text : null, points: step === 2 ? resp.points : null };
        });
        progress[id] = { answered: list.filter((x) => x.text).length, finished: r.finished.includes(id) || turn < answeredTurns(r) };
      }
    });
    const last = r.revealStep > 0 ? cells[Math.floor((r.revealStep - 1) / 2)] : null;
    return {
      mode: 'fastMoney',
      title: r.def.title,
      stage: r.stage,
      participants: r.def.participants,
      stakes: r.def.stakes,
      revealMode: r.def.reveal,
      target: r.def.target,
      multiplier: r.def.pointMultiplier,
      blockDuplicates: r.def.blockDuplicates,
      // Questions stay hidden until the round is under way.
      questions: r.stage === 'intro' ? [] : r.surveys.map((s) => s.question),
      turns: r.turns,
      turn: r.turn,
      timer: timerView(r),
      cells: view,
      progress,
      totals,
      focus: last && r.stage === 'reveal' ? { ...last, step: r.revealStep % 2 === 0 ? 2 : 1 } : null,
      covered,
      topAnswers:
        r.stage === 'result' || r.stage === 'done'
          ? r.surveys.map((s) => {
              const top = [...s.answers].sort((a, b) => b.points - a.points)[0];
              return top ? { text: top.text, points: top.points } : null;
            })
          : [],
      outcome: r.outcome,
    };
  },

  hostView(_g, r) {
    return {
      mode: 'fastMoney',
      surveys: r.surveys.map((s) => ({ question: s.question, answers: s.answers.map((a) => ({ text: a.text, points: a.points })) })),
      responses: r.responses,
      cells: fmCells(r),
      revealStep: r.revealStep,
      revealLimit: revealLimit(r),
    };
  },

  playerView(_g, r, playerId) {
    const turn = turnOf(r, playerId);
    if (turn < 0 || r.stage === 'intro') return {};
    const finished = r.finished.includes(playerId);
    const playing = turn === r.turn && (r.stage === 'ready' || r.stage === 'answering');
    return {
      fastMoney: {
        active: turn === r.turn && r.stage === 'answering' && !finished,
        finished,
        when: playing ? 'now' : turn > r.turn ? 'before' : 'after',
        answers: (r.responses[playerId] ?? []).map((x) => x.text),
      },
    };
  },
};
