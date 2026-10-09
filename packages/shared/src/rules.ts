/**
 * Gameplay rules. A ruleset describes *how* a game is played (rounds, buzzer
 * behaviour, scoring) and never references specific questions, so rulesets and
 * packs can be mixed freely.
 */
import { z } from 'zod';

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const BuzzerRulesSchema = z.object({
  /**
   * `first`: the first buzz the server receives wins.
   * `latencyAdjusted`: buzzes are collected for a short window and ranked after
   * subtracting half of each player's measured round-trip time.
   */
  arbitration: z.enum(['first', 'latencyAdjusted']),
  collectionWindowMs: int(50, 500),
  /** Upper bound on how much any one buzz may be adjusted. */
  maxCompensationMs: int(0, 300),
  /**
   * After the first buzz, how long the other buzzers stay live, so that a buzz
   * a split second behind is recorded and ranked instead of being shut out.
   * It never changes who won. 0 shuts every buzzer the moment someone is in.
   */
  graceMs: int(0, 2000).default(300),
  /** The question timer: seconds players have to buzz, counted from the moment the clue goes up. 0 disables it. */
  buzzSec: int(0, 120),
  /** Seconds the buzz winner has to answer. 0 disables the timer. */
  answerSec: int(0, 120),
  /** After an incorrect answer, open the buzzers again so others can steal. */
  reopenOnIncorrect: z.boolean(),
  /** Let a player who answered incorrectly buzz again on the same clue. */
  rebuzz: z.boolean(),
  /** Percentage of the clue value deducted for an incorrect answer. */
  incorrectPenaltyPct: int(0, 100),
  /** With teams enabled, an incorrect answer locks out the whole team. */
  teamLockout: z.boolean(),
});

export const TriviaRoundSchema = z.object({
  mode: z.literal('trivia'),
  title: z.string().trim().min(1).max(40),
  categories: int(1, 8),
  cluesPerCategory: int(1, 8),
  valueMultiplier: int(1, 20),
  /** Number of hidden wager clues placed at random on the board. */
  wagers: int(0, 6),
  /** A player may wager up to their score, or up to this amount if they have less. */
  wagerCap: int(0, 1_000_000),
  /** Eliminate this many of the lowest-scoring players when the round ends. */
  eliminateLowest: int(0, 20),
});

export const FastMoneyRoundSchema = z.object({
  mode: z.literal('fastMoney'),
  title: z.string().trim().min(1).max(40),
  questions: int(1, 10),
  /**
   * Who plays. `leader` and `top2` take turns alone (classic finale);
   * `all` has every active player answer at once on their phones.
   */
  participants: z.enum(['leader', 'top2', 'all']),
  turnSec: int(10, 600),
  /** Extra seconds granted to each later turn (they must avoid earlier answers). */
  extraSecPerTurn: int(0, 120),
  /** Reject an answer already given by an earlier contestant. */
  blockDuplicates: z.boolean(),
  /**
   * `afterEachTurn`: reveal a contestant's answers before the next one plays (they should look away).
   * `atEnd`: everyone plays first, then answers are revealed side by side, question by question.
   */
  reveal: z.enum(['afterEachTurn', 'atEnd']),
  /**
   * `points`: survey points are added to scores (times the multiplier).
   * `decider`: board scores only seed the round; the highest survey total wins the game.
   */
  stakes: z.enum(['points', 'decider']),
  /** Each survey point is worth this many game points (`points` stakes only). */
  pointMultiplier: int(1, 1000),
  /** Survey points needed to win the bonus. 0 disables the target. */
  target: int(0, 100_000),
  /** Game points awarded for reaching the target. */
  targetBonus: int(0, 10_000_000),
});

/** One written-answer question that everybody wagers on. */
export const FinalRoundSchema = z.object({
  mode: z.literal('final'),
  title: z.string().trim().min(1).max(40),
  /** Seconds to enter a wager. 0 disables the timer. */
  wagerSec: int(0, 300),
  answerSec: int(10, 600),
  /** A player may wager up to their score, or up to this amount if they have less. */
  wagerCap: int(0, 1_000_000),
});

export const RoundDefSchema = z.discriminatedUnion('mode', [TriviaRoundSchema, FastMoneyRoundSchema, FinalRoundSchema]);

export const TeamRulesSchema = z.object({
  enabled: z.boolean(),
  names: z.array(z.string().trim().min(1).max(24)).min(2).max(6),
});

export const GameRulesSchema = z.object({
  name: z.string().trim().min(1).max(60),
  rounds: z.array(RoundDefSchema).min(1).max(8),
  buzzer: BuzzerRulesSchema,
  teams: TeamRulesSchema,
  /** Allow players to join after the game has started. */
  lateJoin: z.boolean(),
  maxPlayers: int(1, 50),
});

export type BuzzerRules = z.infer<typeof BuzzerRulesSchema>;
export type TriviaRoundDef = z.infer<typeof TriviaRoundSchema>;
export type FastMoneyRoundDef = z.infer<typeof FastMoneyRoundSchema>;
export type FinalRoundDef = z.infer<typeof FinalRoundSchema>;
export type RoundDef = z.infer<typeof RoundDefSchema>;
export type GameRules = z.infer<typeof GameRulesSchema>;
export type GameMode = RoundDef['mode'];

export interface Preset {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  rules: GameRules;
}

export const DEFAULT_BUZZER: BuzzerRules = {
  arbitration: 'first',
  collectionWindowMs: 150,
  maxCompensationMs: 150,
  graceMs: 300,
  buzzSec: 30,
  answerSec: 30,
  reopenOnIncorrect: true,
  rebuzz: false,
  incorrectPenaltyPct: 100,
  teamLockout: true,
};

const DEFAULT_TEAMS = { enabled: false, names: ['Team Honey', 'Team Sting'] };

const trivia = (title: string, over: Partial<TriviaRoundDef> = {}): TriviaRoundDef => ({
  mode: 'trivia',
  title,
  categories: 5,
  cluesPerCategory: 5,
  valueMultiplier: 1,
  wagers: 0,
  wagerCap: 1000,
  eliminateLowest: 0,
  ...over,
});

const fastMoney = (over: Partial<FastMoneyRoundDef> = {}): FastMoneyRoundDef => ({
  mode: 'fastMoney',
  title: 'Fast Money',
  questions: 5,
  participants: 'top2',
  turnSec: 45,
  extraSecPerTurn: 10,
  blockDuplicates: true,
  reveal: 'atEnd',
  stakes: 'decider',
  pointMultiplier: 10,
  target: 0,
  targetBonus: 0,
  ...over,
});

const final = (over: Partial<FinalRoundDef> = {}): FinalRoundDef => ({
  mode: 'final',
  title: 'Final Trivia',
  wagerSec: 45,
  answerSec: 60,
  wagerCap: 1000,
  ...over,
});

const everyoneSurvey = (over: Partial<FastMoneyRoundDef>): FastMoneyRoundDef =>
  fastMoney({ participants: 'all', extraSecPerTurn: 0, blockDuplicates: false, stakes: 'points', ...over });

/**
 * Built-in presets. "The Full Show" follows the episode structure described in
 * docs/RESEARCH.md; that document also lists which details are BuzzOff's own
 * defaults rather than anything taken from a televised show.
 */
const base = { teams: DEFAULT_TEAMS, lateJoin: true, maxPlayers: 12 };

export const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'full-show',
    name: 'The Full Show',
    description: 'Two boards (the second at double points), a hidden wager on each, Final Trivia, then a head-to-head Fast Money decider for the top two.',
    builtin: true,
    rules: {
      ...base,
      name: 'The Full Show',
      rounds: [
        trivia('Board One', { wagers: 1 }),
        trivia('Board Two', { valueMultiplier: 2, wagers: 1 }),
        final(),
        fastMoney(),
      ],
      buzzer: DEFAULT_BUZZER,
    },
  },
  {
    id: 'classic',
    name: 'Classic Trivia',
    description: 'One full 6×5 board. Buzz to answer, highest score wins. No finale.',
    builtin: true,
    rules: {
      ...base,
      name: 'Classic Trivia',
      rounds: [trivia('The Board', { categories: 6, wagers: 1 })],
      buzzer: DEFAULT_BUZZER,
    },
  },
  {
    id: 'quick-play',
    name: 'Quick Play',
    description: 'A small 4×4 board, then a survey round everybody plays on their phone. About 20 minutes.',
    builtin: true,
    rules: {
      ...base,
      name: 'Quick Play',
      maxPlayers: 16,
      rounds: [
        trivia('Lightning Board', { categories: 4, cluesPerCategory: 4 }),
        everyoneSurvey({ title: 'Survey Scramble', questions: 3, turnSec: 60 }),
      ],
      buzzer: DEFAULT_BUZZER,
    },
  },
  {
    id: 'jackpot',
    name: 'Jackpot Finale',
    description: 'One board, then the top two team up in a classic Fast Money: reach 200 survey points together for the jackpot.',
    builtin: true,
    rules: {
      ...base,
      name: 'Jackpot Finale',
      rounds: [
        trivia('The Board', { wagers: 1 }),
        fastMoney({ reveal: 'afterEachTurn', stakes: 'points', pointMultiplier: 10, target: 200, targetBonus: 5000 }),
      ],
      buzzer: DEFAULT_BUZZER,
    },
  },
  {
    id: 'survey-night',
    name: 'Survey Night',
    description: 'No board, just surveys: everyone answers on their phone and the reveals do the rest.',
    builtin: true,
    rules: {
      ...base,
      name: 'Survey Night',
      lateJoin: false,
      maxPlayers: 20,
      rounds: [everyoneSurvey({ title: 'Survey Night', questions: 6, turnSec: 90 })],
      buzzer: DEFAULT_BUZZER,
    },
  },
];
