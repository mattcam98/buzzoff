/**
 * Classic trivia: a board of categories, competitive buzzing, host judging.
 *
 * Clue stages:
 *
 *   board ──select──▶ open ──buzz──▶ answering ──correct──▶ result ──continue──▶ board
 *                      ▲                 │
 *                      └────incorrect────┘ (opened again for steals, if allowed)
 *
 * Buzzers open the moment the host selects a clue; nobody arms them. A wager
 * clue skips the buzzer: the player in control wagers, then answers. Pausing
 * shuts an open buzzer (`reading`) and resuming opens it again.
 *
 * While a buzz-in answer is judged the question is hidden from everyone but
 * the host and its timer stands still. A wrong answer brings both back for
 * the players who are still in.
 */
import type { BuzzAck } from '../actions';
import type { ActiveClue, BuzzAttempt, GameState, TriviaRound } from '../state';
import type { BuzzerView, PublicAttempt, TriviaPublic, TriviaSecret } from '../views';
import {
  activePlayers, addScore, fail, maxWager, ranked, requirePlayer, round3, setTimer, shiftTime, timerView,
  type Ctx, type Mode,
} from './core';
import { endRoll, removeFromRoll, rollDie, rollForRest, startRoll, tickRoll } from './dice';

/** Reopened buzzers always get at least this long, so a steal is possible however late the first buzz came. */
const MIN_REOPEN_MS = 5_000;

const HIDDEN: BuzzerView = { state: 'hidden', ms: null, deltaMs: null, rank: null };

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
    fail('no_control', 'This is a wager clue. Give a player the board first.');
  }

  const c: ActiveClue = {
    cat, idx, value: clue.value, stage: 'reading', cycle: 0, openedAt: null, windowEndsAt: null, graceEndsAt: null, decided: null,
    deadline: null, timerMs: null, held: null, attempts: [], answererId: null, excluded: [],
    wager: null, judgments: [], timedOut: false, answerTimeUp: false,
  };
  r.clue = c;
  r.stage = 'clue';
  ctx.events.push({ type: 'clue.selected', wager: clue.wager });

  if (clue.wager && controller) {
    c.stage = 'wager';
    c.wager = { playerId: controller.id, amount: null };
  } else {
    openBuzzers(g, c, ctx, 'full');
  }
}

/** Stop the question timer where it stands, to be picked up when the buzzers next open. */
function holdTimer(c: ActiveClue, now: number): void {
  c.held = c.deadline === null || c.timerMs === null ? null : { leftMs: Math.max(0, c.deadline - now), totalMs: c.timerMs };
}

/**
 * Start a fresh buzz for everyone still eligible. `full` starts the question
 * timer from the top; `resume` carries on with whatever `holdTimer` set aside.
 */
function openBuzzers(g: GameState, c: ActiveClue, ctx: Pick<Ctx, 'now' | 'events'>, clock: 'full' | 'resume'): void {
  c.stage = 'open';
  c.cycle += 1;
  c.openedAt = ctx.now;
  c.attempts = [];
  c.decided = null;
  c.windowEndsAt = null;
  c.graceEndsAt = null;
  c.answererId = null;
  c.answerTimeUp = false;
  if (clock === 'full') {
    setTimer(c, g.rules.buzzer.buzzSec, ctx.now);
  } else {
    const left = c.held && Math.max(c.held.leftMs, MIN_REOPEN_MS);
    c.deadline = left ? ctx.now + left : null;
    c.timerMs = left ? Math.max(c.held!.totalMs, left) : null;
  }
  c.held = null;
  ctx.events.push({ type: 'buzz.open' });
}

/** Pick the winner from the attempts gathered so far and hand them the floor. */
function decide(g: GameState, c: ActiveClue, ctx: Ctx): void {
  const winner = [...c.attempts].sort((a, b) => effectiveMs(a) - effectiveMs(b) || a.seq - b.seq)[0];
  c.decided = c.attempts.length;
  c.windowEndsAt = null;
  c.answererId = winner.playerId;
  c.stage = 'answering';
  holdTimer(c, ctx.now);
  setTimer(c, g.rules.buzzer.answerSec, ctx.now);
  g.stats[winner.playerId].buzzWins += 1;
  ctx.events.push({ type: 'buzz.winner', playerId: winner.playerId });
}

function finish(r: TriviaRound, c: ActiveClue, winnerId: string | null, ctx: Ctx): void {
  c.stage = 'result';
  c.deadline = null;
  c.timerMs = null;
  c.windowEndsAt = null;
  c.graceEndsAt = null;
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
  if (stealable) openBuzzers(g, c, ctx, 'resume');
  else finish(r, c, null, ctx);
}

/** Throw the clue out: undo its scoring, forget its rulings and put it back on the board. */
function cancelClue(g: GameState, r: TriviaRound): void {
  const c = activeClue(r);
  for (const j of c.judgments) {
    addScore(g, j.playerId, -j.delta);
    const stats = g.stats[j.playerId];
    if (stats) stats[j.correct ? 'correct' : 'incorrect'] -= 1;
  }
  const clue = r.board[c.cat].clues[c.idx];
  clue.used = false;
  clue.winnerId = null;
  r.clue = null;
  r.stage = 'board';
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
    const players = activePlayers(g);
    r.stage = 'board';
    // The trailing player opens every board after the first; the first pick of the game is rolled for.
    if (g.roundIndex > 0 && players.some((p) => p.score !== 0)) r.controlId = ranked(players)[players.length - 1].id;
    else if (players.length > 1) startRoll(r, players.map((p) => p.id));
    else r.controlId = players[0]?.id ?? null;
  },

  host(g, r, a, ctx) {
    switch (a.t) {
      case 'clue.select':
        selectClue(g, r, a.cat, a.idx, ctx);
        return true;
      case 'buzz.reset': {
        // Dispute handling: discard the current buzz and open again for everyone still eligible.
        const c = activeClue(r);
        if (c.stage !== 'open' && c.stage !== 'answering') fail('bad_stage', 'There is no buzz to reset');
        if (c.wager) fail('bad_stage', 'A wager clue has no buzzer');
        if (c.answererId) g.stats[c.answererId].buzzWins -= 1;
        if (c.stage === 'open') holdTimer(c, ctx.now);
        openBuzzers(g, c, ctx, 'resume');
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
      case 'roll.finish':
        rollForRest(r, ctx);
        return true;
      case 'control.set':
        requirePlayer(g, a.id);
        r.controlId = a.id;
        // Handing someone the board settles the question the roll was asking.
        if (r.stage === 'roll') endRoll(r);
        if (r.clue?.stage === 'wager' && r.clue.wager) r.clue.wager.playerId = a.id;
        return true;
      case 'wager.set':
        setWager(g, r, null, a.amount, ctx);
        return true;
      default:
        return false;
    }
  },

  // Players never touch the board: they call a clue out loud and the host puts it in play.
  player(g, r, playerId, a, ctx) {
    if (a.t === 'roll') rollDie(r, playerId, ctx);
    else if (a.t === 'wager') setWager(g, r, playerId, a.amount, ctx);
    else return false;
    return true;
  },

  buzz(g, r, playerId, ctx) {
    const c = r.clue;
    const rules = g.rules.buzzer;
    const reject = (status: BuzzAck['status']) => ({ ack: { status }, changed: false });
    const player = g.players[playerId];
    if (!c || !player || c.wager) return reject('closed');
    if (player.eliminated || c.excluded.includes(playerId)) return reject('excluded');

    if (c.stage !== 'open' && c.stage !== 'answering') return reject('closed');
    if (c.answererId === playerId || c.attempts.some((a) => a.playerId === playerId)) return reject('duplicate');
    // Once someone has the floor, a buzz only counts for the record, and only while the grace period lasts.
    if (c.stage === 'answering' && !(c.graceEndsAt && ctx.now < c.graceEndsAt)) return reject('closed');

    const ms = round3(ctx.now - c.openedAt!);
    const rttMs = ctx.rtt(playerId);
    const adjustedMs =
      rules.arbitration === 'latencyAdjusted' ? round3(Math.max(0, ms - Math.min((rttMs ?? 0) / 2, rules.maxCompensationMs))) : null;
    c.attempts.push({ playerId, ms, rttMs, adjustedMs, seq: c.attempts.length });
    // The first buzz starts the grace period in which the others are still taken down. (A game saved before the rule existed has none.)
    const graceMs = rules.graceMs ?? 0;
    if (c.attempts.length === 1 && graceMs > 0) c.graceEndsAt = ctx.now + graceMs;

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
    if (r.stage === 'roll') return tickRoll(r, ctx);
    const c = r.clue;
    if (!c) return;
    // The grace period is over: every phone still showing a live buzzer is told it has shut.
    if (c.graceEndsAt && ctx.now >= c.graceEndsAt) c.graceEndsAt = null;
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

  deadlines: (r) => (r.stage === 'roll' ? [r.roll?.deadline ?? null] : r.clue ? [r.clue.windowEndsAt, r.clue.deadline, r.clue.graceEndsAt ?? null] : []),

  timer: (r) => r.clue,

  shift(r, delta) {
    if (r.roll) r.roll.deadline = shiftTime(r.roll.deadline, delta);
    const c = r.clue;
    if (!c) return;
    c.openedAt = shiftTime(c.openedAt, delta);
    c.windowEndsAt = shiftTime(c.windowEndsAt, delta);
    c.graceEndsAt = shiftTime(c.graceEndsAt ?? null, delta);
    c.deadline = shiftTime(c.deadline, delta);
  },

  interrupt(r) {
    // Buzz timing cannot straddle a pause, so an open buzzer is shut until play resumes.
    const c = r.clue;
    if (c?.stage !== 'open') return;
    // The question timer keeps its deadline: it is moved along with everything else when play resumes.
    c.stage = 'reading';
    c.attempts = [];
    c.decided = null;
    c.windowEndsAt = null;
    c.graceEndsAt = null;
  },

  resume(g, r, ctx) {
    const c = r.clue;
    if (c?.stage !== 'reading') return;
    holdTimer(c, ctx.now);
    openBuzzers(g, c, ctx, 'resume');
  },

  playerRemoved(g, r, playerId) {
    if (r.controlId === playerId) r.controlId = null;
    removeFromRoll(r, playerId);
    const c = r.clue;
    if (!c) return;
    c.attempts = c.attempts.filter((a) => a.playerId !== playerId);
    if (c.decided !== null) c.decided = Math.min(c.decided, c.attempts.length);
    // A collection window with nothing left in it would never close, and with no first buzz there is no grace period either.
    if (!c.attempts.length) c.windowEndsAt = c.graceEndsAt = null;
    // Their turn cannot be completed; throw the clue out. A clue that is already settled stays settled.
    if (c.stage !== 'result' && (c.answererId === playerId || c.wager?.playerId === playerId)) cancelClue(g, r);
  },

  publicView(g, r) {
    const c = r.clue;
    const source = c ? r.board[c.cat].clues[c.idx] : null;
    // A wager is placed blind, so the clue stays hidden until it is locked in. And while a buzz-in
    // answer is being judged nobody gets to keep reading: the question returns with the buzzers.
    const hidden = c?.stage === 'wager' || (c?.stage === 'answering' && !c.wager);
    return {
      mode: 'trivia',
      title: r.def.title,
      stage: r.stage,
      multiplier: r.def.valueMultiplier,
      controlId: r.controlId,
      roll: r.roll
        ? {
            round: r.roll.round, phase: r.roll.phase, contenders: r.roll.contenders, rolls: r.roll.rolls, out: r.roll.out,
            winnerId: r.roll.winnerId,
          }
        : null,
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
              question: hidden ? null : source.question,
              media: hidden ? null : (source.media ?? null),
              answer: c.stage === 'result' ? source.answer : null,
              timer: timerView(c),
              held: c.stage === 'answering' ? (c.held ?? null) : null,
              collecting: c.stage === 'open' && c.attempts.length > 0,
              attempts: publicAttempts(c),
              answererId: c.answererId,
              excluded: c.excluded,
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
    if (!c || !player) return { buzzer: HIDDEN, wager: null };

    const wager =
      c.stage === 'wager' && c.wager?.playerId === playerId
        ? { min: 0, max: maxWager(player.score, r.def.wagerCap), amount: c.wager.amount }
        : null;

    const mine = c.attempts.find((a) => a.playerId === playerId);
    const shown = publicAttempts(c);
    const rank = shown.findIndex((a) => a.playerId === playerId);
    const view = (state: BuzzerView['state']): BuzzerView => ({
      state,
      ms: mine?.ms ?? null,
      deltaMs: rank >= 0 ? shown[rank].deltaMs : null,
      rank: rank >= 0 ? rank + 1 : null,
    });

    let buzzer: BuzzerView;
    if (c.wager || c.stage === 'result' || c.stage === 'wager' || c.stage === 'reading') buzzer = HIDDEN;
    else if (player.eliminated || c.excluded.includes(playerId)) buzzer = view('out');
    // During the grace period a player who has not buzzed yet still has a live buzzer, though the floor is taken.
    else if (c.stage === 'answering') buzzer = view(c.answererId === playerId ? 'yours' : mine || !c.graceEndsAt ? 'taken' : 'open');
    else if (mine) buzzer = view('buzzed');
    else buzzer = view('open');
    return { buzzer, wager };
  },
};
