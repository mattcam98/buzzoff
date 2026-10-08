/** A tiny harness for driving the engine in tests with a controllable clock. */
import type { BuzzAck, HostAction, PlayerAction } from '../actions';
import type { Category, Survey } from '../content';
import {
  BUILTIN_PRESETS, DEFAULT_BUZZER,
  type BuzzerRules, type FastMoneyRoundDef, type FinalRoundDef, type GameRules, type RoundDef, type TriviaRoundDef,
} from '../rules';
import type { GameEvent, GameState } from '../state';
import {
  applyBuzz, applyHost, applyPlayer, applySystem, assembleRounds, createGame, hostView, nextDeadline, playerView, publicView,
  type Picks,
} from './game';

export const categories = (n: number, clues = 5): Category[] =>
  Array.from({ length: n }, (_, c) => ({
    id: `cat${c}`,
    title: `Category ${c}`,
    clues: Array.from({ length: clues }, (_, k) => ({
      id: `cat${c}-${k}`, value: (k + 1) * 100, question: `Question ${c}.${k}?`, answer: `Answer ${c}.${k}`, accept: [],
    })),
  }));

export const surveys = (n: number): Survey[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `sv${i}`,
    question: `Name a fruit (${i})`,
    answers: [
      { text: 'Apple', points: 40, aliases: ['apples'] },
      { text: 'Banana', points: 30, aliases: [] },
      { text: 'Orange', points: 20, aliases: ['clementine'] },
      { text: 'Strawberry', points: 10, aliases: [] },
    ],
  }));

export const TRIVIA: TriviaRoundDef = {
  mode: 'trivia', title: 'Board', categories: 2, cluesPerCategory: 2, valueMultiplier: 1, wagers: 0, wagerCap: 1000,
  selection: 'control', eliminateLowest: 0,
};
export const FAST_MONEY = BUILTIN_PRESETS[0].rules.rounds.find((r): r is FastMoneyRoundDef => r.mode === 'fastMoney')!;
export const FINAL = BUILTIN_PRESETS[0].rules.rounds.find((r): r is FinalRoundDef => r.mode === 'final')!;

export interface SimOptions {
  rounds?: RoundDef[];
  buzzer?: Partial<BuzzerRules>;
  rules?: Partial<GameRules>;
  players?: string[];
  picks?: Picks;
  pool?: { categories: Category[]; surveys: Survey[] };
}

export class Sim {
  state: GameState;
  now = 1_000_000;
  events: GameEvent[] = [];
  rtts: Record<string, number> = {};
  private seed = 1;

  constructor(o: SimOptions = {}) {
    const rules: GameRules = {
      name: 'Test', rounds: o.rounds ?? [TRIVIA], buzzer: { ...DEFAULT_BUZZER, ...o.buzzer },
      teams: { enabled: false, names: ['Red', 'Blue'] }, lateJoin: true, maxPlayers: 12, ...o.rules,
    };
    const pool = o.pool ?? { categories: categories(8), surveys: surveys(8) };
    // Unless a test says otherwise, rounds take content in pack order so expectations are stable.
    let cat = 0;
    let sv = 0;
    const ordered: Picks = rules.rounds.map((r) =>
      r.mode === 'fastMoney'
        ? pool.surveys.slice(sv, (sv += r.questions)).map((x) => x.id)
        : pool.categories.slice(cat, (cat += r.mode === 'trivia' ? r.categories : 1)).map((x) => x.id),
    );
    this.state = createGame({ code: 'TEST', rules, rounds: assembleRounds(rules, pool, o.picks ?? ordered, this.rand), packTitles: ['Test'], now: this.now });
    for (const name of o.players ?? ['ann', 'bob', 'cat']) this.join(name);
  }

  /** Deterministic pseudo-random numbers so tests are repeatable. */
  rand = () => {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  };
  private get env() {
    return { now: this.now, rand: this.rand, rtt: (id: string) => this.rtts[id] ?? null };
  }
  private commit(out: { state: GameState; events: GameEvent[] }) {
    this.state = out.state;
    this.events.push(...out.events);
  }

  join(name: string) {
    this.commit(applySystem(this.state, { t: 'join', id: name, name, avatar: { emoji: '🐝', color: '#FFC400' } }, this.env));
  }
  host(action: HostAction) {
    this.commit(applyHost(this.state, action, this.env));
    return this;
  }
  player(id: string, action: PlayerAction) {
    this.commit(applyPlayer(this.state, id, action, this.env));
    return this;
  }
  buzz(id: string): BuzzAck {
    const out = applyBuzz(this.state, id, this.env);
    this.commit(out);
    return out.ack;
  }
  /** Advance the clock, firing every deadline that falls inside the interval. */
  advance(ms: number) {
    const end = this.now + ms;
    for (let guard = 0; guard < 100; guard++) {
      const due = nextDeadline(this.state);
      if (due === null || due > end) break;
      this.now = Math.max(this.now, due);
      this.commit(applySystem(this.state, { t: 'tick' }, this.env));
    }
    this.now = end;
    return this;
  }

  /** Start the game and enter the first round's play stage. */
  start() {
    return this.host({ t: 'start' }).host({ t: 'round.begin' });
  }
  /** Select a clue and arm the buzzers. */
  open(cat = 0, idx = 0) {
    return this.host({ t: 'clue.select', cat, idx }).host({ t: 'buzz.open' });
  }

  get pub() {
    return publicView(this.state);
  }
  get secret() {
    return hostView(this.state);
  }
  you(id: string) {
    return playerView(this.state, id);
  }
  score(id: string) {
    return this.state.players[id].score;
  }
  get trivia() {
    const r = this.pub.round;
    if (r?.mode !== 'trivia') throw new Error('not a trivia round');
    return r;
  }
  get fm() {
    const r = this.pub.round;
    if (r?.mode !== 'fastMoney') throw new Error('not a fast money round');
    return r;
  }
  get final() {
    const r = this.pub.round;
    if (r?.mode !== 'final') throw new Error('not a final round');
    return r;
  }
  eventTypes() {
    return this.events.map((e) => e.type);
  }
}
