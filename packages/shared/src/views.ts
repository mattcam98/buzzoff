/**
 * What each audience is allowed to see.
 *
 *  - PublicView: the TV, spectators and every player. Never contains an answer
 *    that has not been revealed on screen.
 *  - HostView:   the host's extra, secret information (answers, typed responses).
 *  - PlayerView: one player's private controller state, derived on the server
 *    so the phone never has to guess whether it may buzz.
 */
import type { Media } from './content';
import type { MatchKind } from './normalize';
import type { BuzzerRules, FastMoneyRoundDef, GameMode } from './rules';
import type { Avatar, ClueStage, FmOutcome, GamePhase, Judgment, PlayerStats } from './state';

export interface TimerView {
  endsAt: number;
  totalMs: number;
}

export interface PublicPlayer {
  id: string;
  name: string;
  avatar: Avatar;
  score: number;
  teamId: number | null;
  ready: boolean;
  eliminated: boolean;
  connected: boolean;
}

export interface TeamView {
  id: number;
  name: string;
  score: number;
  playerIds: string[];
}

export interface PublicAttempt {
  playerId: string;
  /** Server-recorded ms from buzzers armed to buzz received. */
  ms: number;
  rttMs: number | null;
  adjustedMs: number | null;
  /** Difference to the winning buzz, using whichever figure decided the order. */
  deltaMs: number;
  winner: boolean;
  /** Arrived after the winner had been decided. */
  late: boolean;
}

export interface TriviaPublic {
  mode: 'trivia';
  title: string;
  stage: 'intro' | 'board' | 'clue' | 'done';
  multiplier: number;
  selection: 'host' | 'control';
  controlId: string | null;
  board: { title: string; blurb?: string; clues: { value: number; used: boolean; winnerId: string | null }[] }[];
  clue: {
    cat: number;
    idx: number;
    category: string;
    value: number;
    stage: ClueStage;
    isWager: boolean;
    singleAttempt: boolean;
    question: string | null;
    media: Media | null;
    answer: string | null;
    timer: TimerView | null;
    /** True while buzzes are being collected and no winner is known yet. */
    collecting: boolean;
    attempts: PublicAttempt[];
    answererId: string | null;
    excluded: string[];
    early: string[];
    judgments: Judgment[];
    wager: { playerId: string; amount: number | null; max: number } | null;
    timedOut: boolean;
    answerTimeUp: boolean;
  } | null;
}

export interface FmCellView {
  text: string | null;
  points: number | null;
}

export interface FastMoneyPublic {
  mode: 'fastMoney';
  title: string;
  stage: 'intro' | 'ready' | 'answering' | 'reveal' | 'result' | 'done';
  participants: FastMoneyRoundDef['participants'];
  stakes: FastMoneyRoundDef['stakes'];
  revealMode: FastMoneyRoundDef['reveal'];
  target: number;
  multiplier: number;
  blockDuplicates: boolean;
  questions: string[];
  turns: string[][];
  turn: number;
  timer: TimerView | null;
  /** Revealed answers and points, per player per question. */
  cells: Record<string, FmCellView[]>;
  progress: Record<string, { answered: number; finished: boolean }>;
  /** Survey points revealed so far. */
  totals: Record<string, number>;
  /** The cell most recently revealed, for highlighting. */
  focus: { turn: number; q: number; step: 1 | 2 } | null;
  /** Earlier contestants' answers are covered while a later one plays. */
  covered: boolean;
  /** The top survey answer per question, shown with the result. */
  topAnswers: ({ text: string; points: number } | null)[];
  outcome: FmOutcome | null;
}

export interface FinalPublic {
  mode: 'final';
  title: string;
  stage: 'intro' | 'wager' | 'answering' | 'reveal' | 'done';
  category: string;
  question: string | null;
  media: Media | null;
  answer: string | null;
  timer: TimerView | null;
  players: string[];
  wagered: string[];
  answered: string[];
  reveals: { playerId: string; answer: string; wager: number | null; correct: boolean | null; delta: number | null }[];
  remaining: number;
}

export type RoundPublic = TriviaPublic | FastMoneyPublic | FinalPublic;

export interface PublicView {
  code: string;
  seq: number;
  name: string;
  packTitles: string[];
  phase: GamePhase;
  paused: boolean;
  pausedAt: number | null;
  lobbyLocked: boolean;
  lateJoin: boolean;
  players: PublicPlayer[];
  teams: TeamView[] | null;
  roundIndex: number;
  rounds: { title: string; mode: GameMode }[];
  round: RoundPublic | null;
  /** Eliminated at the end of the round just played. */
  eliminatedNow: string[];
  stats: Record<string, PlayerStats> | null;
  /** Winning player ids once the game has finished. */
  champions: string[] | null;
  buzzer: Pick<BuzzerRules, 'arbitration' | 'earlyBuzz' | 'arming' | 'rebuzz'>;
}

// ---------------------------------------------------------------- host

export interface TriviaSecret {
  mode: 'trivia';
  board: { question: string; answer: string; wager: boolean; difficulty?: number }[][];
  clue: { question: string; answer: string; accept: string[]; notes: string | null } | null;
}

export interface FastMoneySecret {
  mode: 'fastMoney';
  surveys: { question: string; answers: { text: string; points: number }[] }[];
  responses: Record<string, { text: string; match: number | null; points: number; matchedBy: MatchKind | 'host' | null }[]>;
  cells: { turn: number; q: number }[];
  revealStep: number;
  /** Steps currently available to reveal. */
  revealLimit: number;
}

export interface FinalSecret {
  mode: 'final';
  question: string;
  answer: string;
  accept: string[];
  notes: string | null;
  wagers: Record<string, number>;
  answers: Record<string, string>;
  /** Whether the answer of the player now on screen looks correct. */
  suggestion: boolean | null;
  current: string | null;
}

export type RoundSecret = TriviaSecret | FastMoneySecret | FinalSecret;

export interface HostView {
  round: RoundSecret | null;
  stats: Record<string, PlayerStats>;
}

// ---------------------------------------------------------------- player

export type BuzzerState =
  | 'hidden' // nothing to buzz for
  | 'wait' // clue is up but buzzers are not armed; pressing now is an early buzz
  | 'open'
  | 'out' // cannot buzz on this clue
  | 'buzzed' // registered, winner not decided yet
  | 'yours' // you are answering
  | 'taken'; // someone else is answering

export interface BuzzerView {
  state: BuzzerState;
  /** Server time until which an early-buzz lockout rejects your buzzes. */
  until: number | null;
  /** Your registered buzz for the current cycle, if any. */
  ms: number | null;
  deltaMs: number | null;
  rank: number | null;
}

export interface PlayerView {
  id: string;
  buzzer: BuzzerView;
  /** You are in control and may pick the next clue. */
  canSelect: boolean;
  /** A wager is being asked of you. */
  wager: { min: number; max: number; amount: number | null } | null;
  fastMoney: {
    /** It is your turn and the clock is running. */
    active: boolean;
    finished: boolean;
    /** Whether your turn is still to come, in progress, or over. */
    when: 'before' | 'now' | 'after';
    answers: string[];
  } | null;
  final: { answer: string | null; canAnswer: boolean } | null;
}
