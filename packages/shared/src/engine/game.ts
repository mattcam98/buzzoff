/**
 * The top-level game: lobby, round sequencing, scores, pause and finish.
 * Everything specific to a mode is delegated to its module.
 *
 *   lobby ──start──▶ round(intro ▸ play ▸ done) ──▶ standings ──next──▶ round … ──▶ finished
 *
 * Every entry point takes the current state and returns a new one; the input
 * is never mutated, so the caller can keep old states around for undo.
 */
import type { BuzzAck, HostAction, PlayerAction } from '../actions';
import type { Category, Survey } from '../content';
import type { GameMode, GameRules } from '../rules';
import {
  emptyStats, type Avatar, type BoardCategory, type GameEvent, type GameState, type Player, type RoundState,
} from '../state';
import type { HostView, PlayerView, PublicView, RoundPublic, RoundSecret, TeamView } from '../views';
import { activePlayers, fail, GameError, playersOf, ranked, requirePlayer, type Ctx, type Mode } from './core';
import { fastMoney } from './fastMoney';
import { final } from './final';
import { trivia } from './trivia';

/** The mode registry. Adding a mode means adding one entry here. */
const MODES: Record<GameMode, Mode<any, RoundPublic, RoundSecret>> = { trivia, fastMoney, final };
const modeOf = (r: RoundState): Mode<RoundState, RoundPublic, RoundSecret> => MODES[r.mode];

const currentRound = (g: GameState): RoundState | null => (g.phase === 'round' ? (g.rounds[g.roundIndex] ?? null) : null);

export type Env = Omit<Ctx, 'events'>;
export interface Outcome {
  state: GameState;
  events: GameEvent[];
}

// ---------------------------------------------------------------- assembly

export interface ContentPool {
  categories: Category[];
  surveys: Survey[];
}
/** Per round: the category or survey ids to use, or null to draw at random. */
export type Picks = (string[] | null)[];

function shuffle<T>(items: T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Take `count` items for one round: explicit picks first, then a random fill
 * from whatever is neither used nor reserved by another round's picks.
 */
function draw<T extends { id: string }>(
  all: T[], used: Set<string>, reserved: Set<string>, picked: string[] | null, count: number, what: string, rand: () => number,
): T[] {
  const chosen: T[] = [];
  for (const id of picked ?? []) {
    const item = all.find((x) => x.id === id) ?? fail('content', `A selected ${what} no longer exists`);
    if (used.has(id)) fail('content', `The same ${what} was selected for two rounds`);
    used.add(id);
    chosen.push(item);
  }
  if (chosen.length > count) fail('content', `Too many ${what} selections for one round`);
  for (const item of shuffle(all.filter((x) => !used.has(x.id) && !reserved.has(x.id)), rand)) {
    if (chosen.length === count) break;
    used.add(item.id);
    chosen.push(item);
  }
  if (chosen.length < count) {
    fail('content', `These rules need more content than the selected packs have (short by ${count - chosen.length} ${what})`);
  }
  return chosen;
}

/** Turn rules plus a pool of content into ready-to-play rounds. Content is copied in, so later pack edits never affect a game. */
export function assembleRounds(rules: GameRules, pool: ContentPool, picks: Picks | undefined, rand: () => number): RoundState[] {
  const usedCategories = new Set<string>();
  const usedSurveys = new Set<string>();
  const reserved = new Set((picks ?? []).flatMap((p) => p ?? []));

  return rules.rounds.map((def, i): RoundState => {
    const picked = picks?.[i] ?? null;
    if (def.mode === 'trivia') {
      const categories = draw(pool.categories, usedCategories, reserved, picked, def.categories, 'category', rand);
      const board: BoardCategory[] = categories.map((cat) => ({
        title: cat.title,
        blurb: cat.blurb,
        singleAttempt: cat.singleAttempt ?? false,
        clues: [...cat.clues]
          .sort((a, b) => a.value - b.value)
          .slice(0, def.cluesPerCategory)
          .map((c) => ({
            value: c.value * def.valueMultiplier, question: c.question, answer: c.answer, accept: c.accept,
            notes: c.notes, media: c.media, difficulty: c.difficulty, wager: false, used: false, winnerId: null,
          })),
      }));
      // Wagers hide below the top row so the opening clue is never one.
      const slots = board.flatMap((cat, c) => cat.clues.map((_, k) => ({ c, k }))).filter((s) => s.k > 0 || def.cluesPerCategory === 1);
      for (const s of shuffle(slots, rand).slice(0, def.wagers)) board[s.c].clues[s.k].wager = true;
      return { mode: 'trivia', def, stage: 'intro', board, controlId: null, clue: null };
    }
    if (def.mode === 'final') {
      const [cat] = draw(pool.categories, usedCategories, reserved, picked, 1, 'category', rand);
      const hardest = [...cat.clues].sort((a, b) => b.value - a.value)[0];
      return {
        mode: 'final', def, stage: 'intro', category: cat.title,
        clue: { question: hardest.question, answer: hardest.answer, accept: hardest.accept, notes: hardest.notes, media: hardest.media },
        players: [], wagers: {}, answers: {}, deadline: null, timerMs: null, order: [], shown: 0, results: {},
      };
    }
    const surveys = draw(pool.surveys, usedSurveys, reserved, picked, def.questions, 'survey question', rand);
    return {
      mode: 'fastMoney', def, stage: 'intro', surveys, turns: [], turn: 0, deadline: null, timerMs: null,
      responses: {}, finished: [], revealStep: 0, outcome: null,
    };
  });
}

export function createGame(o: { code: string; rules: GameRules; rounds: RoundState[]; packTitles: string[]; now: number }): GameState {
  return {
    v: 1, code: o.code, createdAt: o.now, seq: 0, rules: o.rules, packTitles: o.packTitles,
    phase: 'lobby', paused: false, pausedAt: null, lobbyLocked: false, roundIndex: 0, rounds: o.rounds,
    players: {}, order: [], teamNames: [...o.rules.teams.names], stats: {}, lastEliminated: [], champions: null, finishedAt: null,
  };
}

// ---------------------------------------------------------------- transitions

function run(state: GameState, env: Env, fn: (g: GameState, ctx: Ctx) => void): Outcome {
  const g: GameState = JSON.parse(JSON.stringify(state));
  const ctx: Ctx = { ...env, events: [] };
  fn(g, ctx);
  // A mode signals completion by reaching its `done` stage.
  if (currentRound(g)?.stage === 'done') endRound(g, ctx);
  g.seq += 1;
  return { state: g, events: ctx.events };
}

function finishGame(g: GameState, ctx: Ctx): void {
  const round = currentRound(g);
  if (round) modeOf(round).interrupt(round);
  g.phase = 'finished';
  g.paused = false;
  g.pausedAt = null;
  g.finishedAt = ctx.now;
  if (!g.champions) {
    const teams = teamViews(g);
    if (teams) {
      const best = Math.max(...teams.map((t) => t.score));
      g.champions = teams.filter((t) => t.score === best).flatMap((t) => t.playerIds);
    } else {
      const players = activePlayers(g);
      const best = Math.max(...players.map((p) => p.score));
      g.champions = players.filter((p) => p.score === best).map((p) => p.id);
    }
  }
  ctx.events.push({ type: 'game.finished' });
}

function endRound(g: GameState, ctx: Ctx): void {
  const round = g.rounds[g.roundIndex];
  modeOf(round).interrupt(round);
  round.stage = 'done';
  g.lastEliminated = [];
  if (round.mode === 'trivia' && round.def.eliminateLowest > 0) {
    const standing = ranked(activePlayers(g));
    // Always leave at least two players in the game.
    const cut = Math.min(round.def.eliminateLowest, Math.max(0, standing.length - 2));
    for (const p of cut ? standing.slice(-cut) : []) {
      g.players[p.id].eliminated = true;
      g.lastEliminated.push(p.id);
    }
  }
  ctx.events.push({ type: 'round.ended', index: g.roundIndex });
  if (g.roundIndex >= g.rounds.length - 1) finishGame(g, ctx);
  else g.phase = 'standings';
}

function removePlayer(g: GameState, id: string): void {
  requirePlayer(g, id);
  for (const r of g.rounds) modeOf(r).playerRemoved(g, r, id);
  delete g.players[id];
  delete g.stats[id];
  g.order = g.order.filter((x) => x !== id);
  g.lastEliminated = g.lastEliminated.filter((x) => x !== id);
  if (g.champions) g.champions = g.champions.filter((x) => x !== id);
}

const nameKey = (name: string) => name.toLowerCase().replace(/\s+/g, '');
/** Names are compared without case or spacing, so "Ann" and "a n n" are the same player. */
export const findPlayerByName = (g: GameState, name: string): Player | undefined =>
  playersOf(g).find((p) => nameKey(p.name) === nameKey(name));
const nameTaken = (g: GameState, name: string, exceptId?: string) =>
  playersOf(g).some((p) => p.id !== exceptId && nameKey(p.name) === nameKey(name));

function smallestTeam(g: GameState): number {
  const sizes = g.teamNames.map((_, i) => playersOf(g).filter((p) => p.teamId === i).length);
  return sizes.indexOf(Math.min(...sizes));
}

export function applyHost(state: GameState, action: HostAction, env: Env): Outcome {
  return run(state, env, (g, ctx) => {
    const round = currentRound(g);
    switch (action.t) {
      case 'start': {
        if (g.phase !== 'lobby') fail('bad_stage', 'The game has already started');
        if (!g.order.length) fail('no_players', 'Wait for at least one player to join');
        g.phase = 'round';
        g.roundIndex = 0;
        ctx.events.push({ type: 'game.started' }, { type: 'round.intro', index: 0 });
        return;
      }
      case 'lobby.lock':
        g.lobbyLocked = action.locked;
        return;
      case 'pause': {
        if (g.phase === 'finished' || g.paused === action.paused) return;
        if (action.paused) {
          g.paused = true;
          g.pausedAt = ctx.now;
          if (round) modeOf(round).interrupt(round);
        } else {
          if (round) modeOf(round).shift(round, ctx.now - (g.pausedAt ?? ctx.now));
          g.paused = false;
          g.pausedAt = null;
        }
        ctx.events.push({ type: 'paused', paused: g.paused });
        return;
      }
      case 'cue':
        ctx.events.push({ type: 'cue', name: action.name });
        return;
      case 'player.kick':
        removePlayer(g, action.id);
        return;
      case 'player.rename':
        if (nameTaken(g, action.name, action.id)) fail('name_taken', 'Another player already has that name');
        requirePlayer(g, action.id).name = action.name;
        return;
      case 'player.team':
        if (action.teamId !== null && !g.teamNames[action.teamId]) fail('no_team', 'No such team');
        requirePlayer(g, action.id).teamId = action.teamId;
        return;
      case 'player.eliminate': {
        const p = requirePlayer(g, action.id);
        p.eliminated = action.eliminated;
        if (!action.eliminated) g.lastEliminated = g.lastEliminated.filter((id) => id !== p.id);
        return;
      }
      case 'team.rename':
        if (!g.teamNames[action.teamId]) fail('no_team', 'No such team');
        g.teamNames[action.teamId] = action.name;
        return;
      case 'teams.shuffle': {
        if (!g.rules.teams.enabled) fail('no_teams', 'Teams are not enabled for this game');
        const ids = [...g.order];
        for (let i = ids.length - 1; i > 0; i--) {
          const j = Math.floor(ctx.rand() * (i + 1));
          [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        ids.forEach((id, i) => (g.players[id].teamId = i % g.teamNames.length));
        return;
      }
      case 'score.adjust':
        requirePlayer(g, action.id).score += action.delta;
        return;
      case 'score.set':
        requirePlayer(g, action.id).score = action.score;
        return;
      case 'game.end':
        if (g.phase === 'finished') fail('bad_stage', 'The game is already over');
        finishGame(g, ctx);
        return;
      case 'round.next':
        if (g.phase !== 'standings') fail('bad_stage', 'The round is still being played');
        g.roundIndex += 1;
        g.phase = 'round';
        g.lastEliminated = [];
        ctx.events.push({ type: 'round.intro', index: g.roundIndex });
        return;
      case 'undo':
      case 'claim.resolve':
        // Handled by the room, which owns history and player credentials.
        return fail('unsupported', 'Not a game action');
    }

    if (!round) return fail('bad_stage', 'No round is in play');
    if (g.paused) fail('paused', 'Resume the game first');
    const mode = modeOf(round);
    switch (action.t) {
      case 'round.begin':
        if (round.stage !== 'intro') fail('bad_stage', 'The round has already begun');
        mode.begin(g, round, ctx);
        ctx.events.push({ type: 'round.started', index: g.roundIndex });
        return;
      case 'round.end':
        endRound(g, ctx);
        return;
      case 'timer.extend': {
        const t = mode.timer(round);
        if (!t || t.deadline === null) return fail('no_timer', 'No timer is running');
        t.deadline += action.sec * 1000;
        t.timerMs = (t.timerMs ?? 0) + action.sec * 1000;
        return;
      }
      case 'timer.stop': {
        const t = mode.timer(round);
        if (!t || t.deadline === null) return fail('no_timer', 'No timer is running');
        t.deadline = null;
        t.timerMs = null;
        return;
      }
      default:
        if (!mode.host(g, round, action, ctx)) fail('bad_stage', 'That is not possible in this round');
    }
  });
}

export function applyPlayer(state: GameState, playerId: string, action: PlayerAction, env: Env): Outcome {
  return run(state, env, (g, ctx) => {
    const player = requirePlayer(g, playerId);
    switch (action.t) {
      case 'ready':
        player.ready = action.ready;
        return;
      case 'profile':
        if (g.phase !== 'lobby') fail('bad_stage', 'Names are locked once the game starts');
        if (nameTaken(g, action.name, playerId)) fail('name_taken', 'Someone already has that name');
        player.name = action.name;
        player.avatar = action.avatar;
        return;
      case 'team':
        if (g.phase !== 'lobby' || !g.rules.teams.enabled) fail('bad_stage', 'Teams cannot be changed now');
        if (!g.teamNames[action.teamId]) fail('no_team', 'No such team');
        player.teamId = action.teamId;
        return;
    }
    const round = currentRound(g);
    if (!round) return fail('bad_stage', 'Nothing to do right now');
    if (g.paused) fail('paused', 'The game is paused');
    if (player.eliminated) fail('eliminated', 'You have been eliminated');
    if (!modeOf(round).player(g, round, playerId, action, ctx)) fail('bad_stage', 'That is not possible right now');
  });
}

/** Register a buzz. Returns the unchanged state when the buzz had no effect. */
export function applyBuzz(state: GameState, playerId: string, env: Env): Outcome & { ack: BuzzAck } {
  const round = currentRound(state);
  const mode = round ? modeOf(round) : null;
  if (!round || !mode?.buzz || state.paused) return { state, events: [], ack: { status: 'closed' } };
  let ack: BuzzAck = { status: 'closed' };
  let changed = false;
  const out = run(state, env, (g, ctx) => {
    ({ ack, changed } = mode.buzz!(g, g.rounds[g.roundIndex], playerId, ctx));
  });
  return changed ? { ...out, ack } : { state, events: [], ack };
}

export type SystemAction =
  | { t: 'join'; id: string; name: string; avatar: Avatar }
  | { t: 'presence'; id: string; connected: boolean }
  | { t: 'tick' }
  /** After a server restart: timers cannot be trusted, so the game resumes paused. */
  | { t: 'recover'; savedAt: number }
  /** Play again in the same room with the same players. */
  | { t: 'rematch'; rules: GameRules; rounds: RoundState[]; packTitles: string[] };

export function applySystem(state: GameState, action: SystemAction, env: Env): Outcome {
  return run(state, env, (g, ctx) => {
    const round = currentRound(g);
    switch (action.t) {
      case 'join': {
        if (g.phase === 'finished') fail('closed', 'That game has finished');
        if (g.phase !== 'lobby' && !g.rules.lateJoin) fail('closed', 'That game has already started');
        if (g.lobbyLocked) fail('closed', 'The host has locked the room');
        if (g.order.length >= g.rules.maxPlayers) fail('full', 'That game is full');
        if (nameTaken(g, action.name)) fail('name_taken', 'Someone already has that name');
        const player: Player = {
          id: action.id, name: action.name, avatar: action.avatar, score: 0,
          teamId: g.rules.teams.enabled ? smallestTeam(g) : null,
          ready: false, eliminated: false, connected: false, joinedAt: ctx.now,
        };
        g.players[player.id] = player;
        g.order.push(player.id);
        g.stats[player.id] = emptyStats();
        ctx.events.push({ type: 'player.joined', playerId: player.id });
        return;
      }
      case 'presence':
        if (g.players[action.id]) g.players[action.id].connected = action.connected;
        return;
      case 'tick':
        if (round && !g.paused) modeOf(round).tick(g, round, ctx);
        return;
      case 'recover':
        for (const p of playersOf(g)) p.connected = false;
        if (round && !g.paused) {
          modeOf(round).interrupt(round);
          g.paused = true;
          g.pausedAt = action.savedAt;
        }
        return;
      case 'rematch':
        g.rules = action.rules;
        g.rounds = action.rounds;
        g.packTitles = action.packTitles;
        g.phase = 'lobby';
        g.paused = false;
        g.pausedAt = null;
        g.roundIndex = 0;
        g.lastEliminated = [];
        g.champions = null;
        g.finishedAt = null;
        g.teamNames = g.rules.teams.names.map((name, i) => g.teamNames[i] ?? name);
        for (const p of playersOf(g)) {
          p.score = 0;
          p.ready = false;
          p.eliminated = false;
          if (!g.rules.teams.enabled) p.teamId = null;
          else if (p.teamId === null || !g.teamNames[p.teamId]) p.teamId = smallestTeam(g);
          g.stats[p.id] = emptyStats();
        }
        return;
    }
  });
}

/** Restore an earlier snapshot while keeping today's roster and connection state. */
export function restoreSnapshot(current: GameState, snapshot: GameState, takenAt: number, now: number): GameState {
  const g: GameState = JSON.parse(JSON.stringify(snapshot));
  for (const id of Object.keys(g.players)) {
    const live = current.players[id];
    if (!live) {
      for (const r of g.rounds) modeOf(r).playerRemoved(g, r, id);
      delete g.players[id];
      delete g.stats[id];
    } else {
      Object.assign(g.players[id], { name: live.name, avatar: live.avatar, connected: live.connected, teamId: live.teamId });
    }
  }
  for (const id of current.order) {
    if (!g.players[id]) {
      g.players[id] = { ...current.players[id] };
      g.stats[id] = current.stats[id] ?? emptyStats();
    }
  }
  g.order = current.order.filter((id) => g.players[id]);
  g.lobbyLocked = current.lobbyLocked;
  const round = currentRound(g);
  if (round) {
    // Timers keep whatever time they had left; an armed buzzer is disarmed.
    modeOf(round).interrupt(round);
    modeOf(round).shift(round, now - (g.paused && g.pausedAt !== null ? g.pausedAt : takenAt));
  }
  if (g.paused) g.pausedAt = now;
  g.seq = current.seq + 1;
  return g;
}

/** The next server time at which a `tick` is due, or null. */
export function nextDeadline(g: GameState): number | null {
  const round = currentRound(g);
  if (!round || g.paused) return null;
  const times = modeOf(round).deadlines(round).filter((t): t is number => t !== null);
  return times.length ? Math.min(...times) : null;
}

// ---------------------------------------------------------------- views

function teamViews(g: GameState): TeamView[] | null {
  if (!g.rules.teams.enabled) return null;
  return g.teamNames.map((name, id) => {
    const members = playersOf(g).filter((p) => p.teamId === id);
    return { id, name, score: members.reduce((n, p) => n + p.score, 0), playerIds: members.map((p) => p.id) };
  });
}

export function publicView(g: GameState): PublicView {
  const round = currentRound(g);
  return {
    code: g.code,
    seq: g.seq,
    name: g.rules.name,
    packTitles: g.packTitles,
    phase: g.phase,
    paused: g.paused,
    pausedAt: g.pausedAt,
    lobbyLocked: g.lobbyLocked,
    lateJoin: g.rules.lateJoin,
    players: playersOf(g).map(({ joinedAt: _joinedAt, ...p }) => p),
    teams: teamViews(g),
    roundIndex: g.roundIndex,
    rounds: g.rounds.map((r) => ({ title: r.def.title, mode: r.mode })),
    round: round ? modeOf(round).publicView(g, round) : null,
    eliminatedNow: g.lastEliminated,
    stats: g.phase === 'standings' || g.phase === 'finished' ? g.stats : null,
    champions: g.phase === 'finished' ? g.champions : null,
    buzzer: {
      arbitration: g.rules.buzzer.arbitration,
      earlyBuzz: g.rules.buzzer.earlyBuzz,
      arming: g.rules.buzzer.arming,
      rebuzz: g.rules.buzzer.rebuzz,
    },
  };
}

export function hostView(g: GameState): HostView {
  const round = currentRound(g);
  return { round: round ? modeOf(round).hostView(g, round) : null, stats: g.stats };
}

export function playerView(g: GameState, playerId: string): PlayerView {
  const round = currentRound(g);
  const base: PlayerView = {
    id: playerId,
    buzzer: { state: 'hidden', until: null, ms: null, deltaMs: null, rank: null },
    canSelect: false,
    wager: null,
    fastMoney: null,
    final: null,
  };
  if (!round || g.paused || !g.players[playerId] || g.players[playerId].eliminated) return base;
  return { ...base, ...modeOf(round).playerView(g, round, playerId) };
}

export { GameError };
