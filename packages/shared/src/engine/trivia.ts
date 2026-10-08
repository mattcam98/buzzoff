/**
 * Classic trivia: a board of categories, competitive buzzing, host judging.
 *
 * Clue stages:
 *
 *   board ──select──▶ reading ──arm──▶ open ──buzz──▶ answering ──correct──▶ result ──continue──▶ board
 *                        ▲              │  ▲               │
 *                        └────close─────┘  └──incorrect────┘ (re-armed for steals, if allowed)
 *
 * A wager clue skips the buzzer: the player in control wagers, then answers.
 */
import type { BuzzAck } from '../actions';
import type { ActiveClue, BuzzAttempt, GameState, TriviaRound } from '../state';
import type { BuzzerView, PublicAttempt, TriviaPublic, TriviaSecret } from '../views';
import {
  activePlayers, addScore, fail, maxWager, ranked, requirePlayer, round3, setTimer, shiftTime, timerView,
  type Ctx, type Mode,
} from './core';

const HIDDEN: BuzzerView = { state: 'hidden', until: null, ms: null, deltaMs: null, rank: null };

const activeClue = (r: TriviaRound): ActiveClue => r.clue ?? fail('no_clue', 'No clue is in play');

const canStillBuzz = (g: GameState, c: ActiveClue) => activePlayers(g).filter((p) => !c.excluded.includes(p.id));

/** The figure that decides buzz order under the current arbitration rule. */
const effectiveMs = (a: BuzzAttempt) => a.adjustedMs ?? a.ms;

function selectClue(g: GameState, r: TriviaRound, cat: number, idx: number, ctx: Ctx): void {
  if (r.stage !== 'board') fail('bad_stage', 'A clue can only be picked from the board');
  const clue = r.board[cat]?.clues[idx] ?? fail('no_clue', 'That clue does not exist');
  if (clue.used) fail('clue_used', 'That clue has already been played');

  const controller = r.controlId ? g.players[r.controlId] : undefined;
  if (clue.wager && (!controller || controller.eliminated)) {
    fail('no_control', 'This is a wager clue: give a player control of the board first');
  }

  const c: ActiveClue = {
    cat, idx, value: clue.value, stage: 'reading', cycle: 0, openedAt: null, windowEndsAt: null, decided: null,
    deadline: null, timerMs: null, attempts: [], answererId: null, excluded: [], lockouts: {}, early: [],
    wager: null, judgments: [], timedOut: false, answerTimeUp: false,
  };
  r.clue = c;
  r.stage = 'clue';
  ctx.events.push({ type: 'clue.selected', wager: clue.wager });

  if (clue.wager && controller) {
    c.stage = 'wager';
    c.wager = { playerId: controller.id, amount: null };
  } else if (g.rules.buzzer.arming === 'auto') {
    armBuzzers(g, c, ctx);
  }
}

function armBuzzers(g: GameState, c: ActiveClue, ctx: Ctx): void {
  c.stage = 'open';
  c.cycle += 1;
  c.openedAt = ctx.now;
  c.attempts = [];
  c.decided = null;
  c.windowEndsAt = null;
  c.answererId = null;
  c.answerTimeUp = false;
  setTimer(c, g.rules.buzzer.buzzSec, ctx.now);
  ctx.events.push({ type: 'buzz.open' });
}

/** Pick the winner from the attempts gathered so far and hand them the floor. */
function decide(g: GameState, c: ActiveClue, ctx: Ctx): void {
  const winner = [...c.attempts].sort((a, b) => effectiveMs(a) - effectiveMs(b) || a.seq - b.seq)[0];
  c.decided = c.attempts.length;
  c.windowEndsAt = null;
  c.answererId = winner.playerId;
  c.stage = 'answering';
  setTimer(c, g.rules.buzzer.answerSec, ctx.now);
  g.stats[winner.playerId].buzzWins += 1;
  ctx.events.push({ type: 'buzz.winner', playerId: winner.playerId });
}

function finish(r: TriviaRound, c: ActiveClue, winnerId: string | null, ctx: Ctx): void {
  c.stage = 'result';
  c.deadline = null;
  c.timerMs = null;
  c.windowEndsAt = null;
  c.answererId = null;
  const clue = r.board[c.cat].clues[c.idx];
  clue.used = true;
  clue.winnerId = winnerId;
  ctx.events.push({ type: 'clue.result' });
}

function setWager(g: GameState, r: TriviaRound, playerId: string | null, amount: number, ctx: Ctx): void {
  const c = activeClue(r);
  if (c.stage !== 'wager' || !c.wager) fail('bad_stage', 'No wager is being taken');
  if (playerId !== null && playerId !== c.wager!.playerId) fail('not_yours', 'This wager is not yours to make');
  const max = maxWager(requirePlayer(g, c.wager!.playerId).score, r.def.wagerCap);
  if (amount < 0 || amount > max) fail('bad_wager', `Wager between 0 and ${max}`);
  c.wager!.amount = amount;
  c.answererId = c.wager!.playerId;
  c.stage = 'answering';
  ctx.events.push({ type: 'wager.locked', playerId: c.wager!.playerId });
}

function judge(g: GameState, r: TriviaRound, correct: boolean, ctx: Ctx): void {
  const c = activeClue(r);
  if (c.stage !== 'answering' || !c.answererId) fail('bad_stage', 'Nobody is answering');
  const playerId = c.answererId!;
  const rules = g.rules.buzzer;
  const stake = c.wager ? (c.wager.amount ?? 0) : c.value;
  const delta = correct ? stake : -(c.wager ? stake : Math.round((stake * rules.incorrectPenaltyPct) / 100));

  addScore(g, playerId, delta);
  c.judgments.push({ playerId, correct, delta });
  g.stats[playerId][correct ? 'correct' : 'incorrect'] += 1;
  ctx.events.push({ type: 'judged', playerId, correct, delta });

  if (correct) {
    r.controlId = playerId;
    finish(r, c, playerId, ctx);
    return;
  }
  if (!rules.rebuzz) {
    const team = g.players[playerId]?.teamId ?? null;
    const lockTeam = g.rules.teams.enabled && rules.teamLockout && team !== null;
    for (const p of activePlayers(g)) {
      if ((p.id === playerId || (lockTeam && p.teamId === team)) && !c.excluded.includes(p.id)) c.excluded.push(p.id);
    }
  }
  const stealable = !c.wager && !r.board[c.cat].singleAttempt && rules.reopenOnIncorrect && canStillBuzz(g, c).length > 0;
  if (stealable) armBuzzers(g, c, ctx);
  else finish(r, c, null, ctx);
}

/** Throw the clue out: undo its scoring and put it back on the board. */
function cancelClue(g: GameState, r: TriviaRound): void {
  const c = activeClue(r);
  for (const j of c.judgments) addScore(g, j.playerId, -j.delta);
  const clue = r.board[c.cat].clues[c.idx];
  clue.used = false;
  clue.winnerId = null;
  r.clue = null;
  r.stage = 'board';
}

function firstControl(g: GameState, ctx: Ctx): string | null {
  const players = activePlayers(g);
  if (!players.length) return null;
  // The trailing player opens every board after the first; the first is drawn at random.
  const anyScore = players.some((p) => p.score !== 0);
  if (g.roundIndex > 0 && anyScore) return ranked(players)[players.length - 1].id;
  return players[Math.floor(ctx.rand() * players.length)].id;
}

function publicAttempts(c: ActiveClue): PublicAttempt[] {
  if (c.decided === null) return [];
  const counted = c.attempts.slice(0, c.decided);
  const winner = counted.find((a) => a.playerId === c.answererId) ?? [...counted].sort((a, b) => effectiveMs(a) - effectiveMs(b) || a.seq - b.seq)[0];
  if (!winner) return [];
  return c.attempts
    .map((a, i) => ({
      playerId: a.playerId,
      ms: a.ms,
      rttMs: a.rttMs,
      adjustedMs: a.adjustedMs,
      deltaMs: round3(effectiveMs(a) - effectiveMs(winner)),
      winner: a === winner,
      late: i >= c.decided!,
    }))
    .sort((a, b) => Number(b.winner) - Number(a.winner) || Number(a.late) - Number(b.late) || a.deltaMs - b.deltaMs);
}

export const trivia: Mode<TriviaRound, TriviaPublic, TriviaSecret> = {
  begin(g, r, ctx) {
    r.stage = 'board';
    r.controlId = firstControl(g, ctx);
  },

  host(g, r, a, ctx) {
    switch (a.t) {
      case 'clue.select':
        selectClue(g, r, a.cat, a.idx, ctx);
        return true;
      case 'buzz.open': {
        const c = activeClue(r);
        if (c.stage !== 'reading') fail('bad_stage', 'Buzzers can only be armed while the clue is being read');
        armBuzzers(g, c, ctx);
        return true;
      }
      case 'buzz.close': {
        const c = activeClue(r);
        if (c.stage !== 'open') fail('bad_stage', 'Buzzers are not armed');
        trivia.interrupt(r);
        return true;
      }
      case 'buzz.reset': {
        // Dispute handling: discard the current buzz and re-arm for everyone still eligible.
        const c = activeClue(r);
        if (c.stage !== 'open' && c.stage !== 'answering') fail('bad_stage', 'There is no buzz to reset');
        if (c.wager) fail('bad_stage', 'A wager clue has no buzzer');
        if (c.answererId) g.stats[c.answererId].buzzWins -= 1;
        armBuzzers(g, c, ctx);
        return true;
      }
      case 'judge':
        judge(g, r, a.correct, ctx);
        return true;
      case 'clue.reveal': {
        const c = activeClue(r);
        if (c.stage === 'result') fail('bad_stage', 'The answer is already showing');
        if (c.stage === 'wager') fail('bad_stage', 'Take the wager first, or cancel the clue');
        finish(r, c, null, ctx);
        return true;
      }
      case 'clue.continue': {
        const c = activeClue(r);
        if (c.stage !== 'result') fail('bad_stage', 'Finish the clue first');
        r.clue = null;
        r.stage = r.board.every((cat) => cat.clues.every((cl) => cl.used)) ? 'done' : 'board';
        return true;
      }
      case 'clue.cancel':
        cancelClue(g, r);
        return true;
      case 'control.set':
        requirePlayer(g, a.id);
        r.controlId = a.id;
        if (r.clue?.stage === 'wager' && r.clue.wager) r.clue.wager.playerId = a.id;
        return true;
      case 'wager.set':
        setWager(g, r, null, a.amount, ctx);
        return true;
      default:
        return false;
    }
  },

  player(g, r, playerId, a, ctx) {
    switch (a.t) {
      case 'select':
        if (r.def.selection !== 'control' || r.controlId !== playerId) fail('not_yours', 'You are not picking right now');
        selectClue(g, r, a.cat, a.idx, ctx);
        return true;
      case 'wager':
        setWager(g, r, playerId, a.amount, ctx);
        return true;
      default:
        return false;
    }
  },

  buzz(g, r, playerId, ctx) {
    const c = r.clue;
    const rules = g.rules.buzzer;
    const reject = (status: BuzzAck['status']) => ({ ack: { status }, changed: false });
    const player = g.players[playerId];
    if (!c || !player || c.wager) return reject('closed');
    if (player.eliminated || c.excluded.includes(playerId)) return reject('excluded');

    if (c.stage === 'reading') {
      if (rules.earlyBuzz === 'ignore') return reject('early');
      if (rules.earlyBuzz === 'penalty' && !c.early.includes(playerId)) addScore(g, playerId, -rules.earlyPenalty);
      if (!c.early.includes(playerId)) {
        c.early.push(playerId);
        g.stats[playerId].earlyBuzzes += 1;
      }
      // Every early press restarts the lockout, so mashing the button never helps.
      c.lockouts[playerId] = ctx.now + rules.earlyLockoutMs;
      ctx.events.push({ type: 'buzz.early', playerId });
      return { ack: { status: 'early' }, changed: true };
    }

    if (c.stage !== 'open' && c.stage !== 'answering') return reject('closed');
    if ((c.lockouts[playerId] ?? 0) > ctx.now) return reject('lockedOut');
    if (c.answererId === playerId || c.attempts.some((a) => a.playerId === playerId)) return reject('duplicate');

    const ms = round3(ctx.now - c.openedAt!);
    const rttMs = ctx.rtt(playerId);
    const adjustedMs =
      rules.arbitration === 'latencyAdjusted' ? round3(Math.max(0, ms - Math.min((rttMs ?? 0) / 2, rules.maxCompensationMs))) : null;
    c.attempts.push({ playerId, ms, rttMs, adjustedMs, seq: c.attempts.length });

    const stats = g.stats[playerId];
    stats.buzzes += 1;
    stats.buzzMsTotal += ms;
    stats.fastestMs = stats.fastestMs === null ? ms : Math.min(stats.fastestMs, ms);

    if (c.stage === 'open') {
      if (rules.arbitration === 'first') decide(g, c, ctx);
      else if (c.windowEndsAt === null) c.windowEndsAt = ctx.now + rules.collectionWindowMs;
    }
    return { ack: { status: 'registered', ms }, changed: true };
  },

  tick(g, r, ctx) {
    const c = r.clue;
    if (!c) return;
    if (c.stage === 'open') {
      const windowDone = c.windowEndsAt !== null && ctx.now >= c.windowEndsAt;
      const timeUp = c.deadline !== null && ctx.now >= c.deadline;
      if (c.attempts.length && (windowDone || timeUp)) {
        decide(g, c, ctx);
      } else if (timeUp) {
        c.timedOut = true;
        ctx.events.push({ type: 'timeup', what: 'buzz' });
        finish(r, c, null, ctx);
      }
    } else if (c.stage === 'answering' && c.deadline !== null && ctx.now >= c.deadline) {
      // The host still makes the call; the clock only tells the room that time is up.
      c.deadline = null;
      c.answerTimeUp = true;
      ctx.events.push({ type: 'timeup', what: 'answer' });
    }
  },

  deadlines: (r) => (r.clue ? [r.clue.windowEndsAt, r.clue.deadline] : []),

  timer: (r) => r.clue,

  shift(r, delta) {
    const c = r.clue;
    if (!c) return;
    c.openedAt = shiftTime(c.openedAt, delta);
    c.windowEndsAt = shiftTime(c.windowEndsAt, delta);
    c.deadline = shiftTime(c.deadline, delta);
    for (const id of Object.keys(c.lockouts)) c.lockouts[id] += delta;
  },

  interrupt(r) {
    // Buzz timing cannot straddle a pause, so an armed buzzer goes back to "reading".
    const c = r.clue;
    if (c?.stage !== 'open') return;
    c.stage = 'reading';
    c.attempts = [];
    c.decided = null;
    c.windowEndsAt = null;
    c.deadline = null;
    c.timerMs = null;
  },

  playerRemoved(_g, r, playerId) {
    if (r.controlId === playerId) r.controlId = null;
    const c = r.clue;
    if (!c) return;
    c.attempts = c.attempts.filter((a) => a.playerId !== playerId);
    if (c.decided !== null) c.decided = Math.min(c.decided, c.attempts.length);
    if (c.answererId === playerId || c.wager?.playerId === playerId) {
      // Their turn cannot be completed; put the clue back on the board.
      r.board[c.cat].clues[c.idx].used = false;
      r.clue = null;
      r.stage = 'board';
    }
  },

  publicView(g, r) {
    const c = r.clue;
    const source = c ? r.board[c.cat].clues[c.idx] : null;
    return {
      mode: 'trivia',
      title: r.def.title,
      stage: r.stage,
      multiplier: r.def.valueMultiplier,
      selection: r.def.selection,
      controlId: r.controlId,
      board: r.board.map((cat) => ({
        title: cat.title,
        blurb: cat.blurb,
        clues: cat.clues.map((cl) => ({ value: cl.value, used: cl.used, winnerId: cl.winnerId })),
      })),
      clue:
        c && source
          ? {
              cat: c.cat,
              idx: c.idx,
              category: r.board[c.cat].title,
              value: c.value,
              stage: c.stage,
              isWager: !!c.wager,
              singleAttempt: r.board[c.cat].singleAttempt,
              // A wager is placed blind: the clue stays hidden until it is locked in.
              question: c.stage === 'wager' ? null : source.question,
              media: c.stage === 'wager' ? null : (source.media ?? null),
              answer: c.stage === 'result' ? source.answer : null,
              timer: timerView(c),
              collecting: c.stage === 'open' && c.attempts.length > 0,
              attempts: publicAttempts(c),
              answererId: c.answererId,
              excluded: c.excluded,
              early: c.early,
              judgments: c.judgments,
              wager: c.wager
                ? { ...c.wager, max: maxWager(g.players[c.wager.playerId]?.score ?? 0, r.def.wagerCap) }
                : null,
              timedOut: c.timedOut,
              answerTimeUp: c.answerTimeUp,
            }
          : null,
    };
  },

  hostView(_g, r) {
    const c = r.clue;
    const source = c ? r.board[c.cat].clues[c.idx] : null;
    return {
      mode: 'trivia',
      board: r.board.map((cat) =>
        cat.clues.map((cl) => ({ question: cl.question, answer: cl.answer, wager: cl.wager, difficulty: cl.difficulty })),
      ),
      clue: source ? { question: source.question, answer: source.answer, accept: source.accept, notes: source.notes ?? null } : null,
    };
  },

  playerView(g, r, playerId) {
    const player = g.players[playerId];
    const c = r.clue;
    const canSelect = r.stage === 'board' && r.def.selection === 'control' && r.controlId === playerId;
    if (!c || !player) return { buzzer: HIDDEN, canSelect, wager: null };

    const wager =
      c.stage === 'wager' && c.wager?.playerId === playerId
        ? { min: 0, max: maxWager(player.score, r.def.wagerCap), amount: c.wager.amount }
        : null;

    const mine = c.attempts.find((a) => a.playerId === playerId);
    const shown = publicAttempts(c);
    const rank = shown.findIndex((a) => a.playerId === playerId);
    const view = (state: BuzzerView['state'], until: number | null = null): BuzzerView => ({
      state,
      until,
      ms: mine?.ms ?? null,
      deltaMs: rank >= 0 ? shown[rank].deltaMs : null,
      rank: rank >= 0 ? rank + 1 : null,
    });

    let buzzer: BuzzerView;
    const lockedUntil = c.lockouts[playerId] ?? 0;
    if (c.wager || c.stage === 'result' || c.stage === 'wager') buzzer = HIDDEN;
    else if (player.eliminated || c.excluded.includes(playerId)) buzzer = view('out');
    else if (c.stage === 'answering') buzzer = view(c.answererId === playerId ? 'yours' : 'taken');
    else if (mine) buzzer = view('buzzed');
    else if (c.stage === 'reading') buzzer = view('wait', lockedUntil || null);
    else buzzer = view('open', lockedUntil || null);
    return { buzzer, canSelect, wager };
  },
};
