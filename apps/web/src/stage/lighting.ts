/**
 * What the stage behind the shared screen is doing at each point in a game: how the floor is lit,
 * and which moments send a ripple of light across it. Nothing here draws anything (hive.ts does),
 * so the whole of it can be checked without a browser.
 */
import type { GameEvent, PublicView } from '@buzzoff/shared';

/** Red, green and blue, each from 0 to 1. */
export type Rgb = readonly [number, number, number];

export const rgb = (hex: string): Rgb => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** The palette of base.css, for the lights. */
const VIOLET = rgb('#5a3cdc');
const INDIGO = rgb('#2f2a8f');
const AMBER = rgb('#ffc400');
const PINK = rgb('#ff4d8d');
const CYAN = rgb('#3ddcff');
const GOOD = rgb('#58e88a');
const BAD = rgb('#ff5c6c');
const WHITE = rgb('#f6f4ff');

export interface Look {
  /** The haze over the back of the stage, which the floor fades into. */
  glow: Rgb;
  /** The wash over the middle of the floor. */
  key: Rgb;
  /** The pools of light in the two near corners. */
  left: Rgb;
  right: Rgb;
  /** How brightly the floor is lit. */
  level: number;
  /** How high the swell that rolls through the tiles lifts them. */
  swell: number;
  /** How fast it rolls. */
  pace: number;
  /** How many tiles are twinkling, from none (0) to a floor full of them (1). */
  sparkle: number;
}

export type Lighting = 'house' | 'titles' | 'board' | 'question' | 'spotlight' | 'wager' | 'think' | 'survey' | 'standings' | 'finale';

/**
 * The more there is to read on the screen, the less the floor does: a board or a question gets a
 * dim, slow floor, and the floor is at its liveliest when there is only a title or a champion on it.
 */
export const LOOKS: Record<Lighting, Look> = {
  house: { glow: VIOLET, key: AMBER, left: CYAN, right: PINK, level: 0.8, swell: 0.55, pace: 1, sparkle: 0.25 },
  titles: { glow: VIOLET, key: VIOLET, left: PINK, right: AMBER, level: 1, swell: 0.9, pace: 1.5, sparkle: 0.45 },
  board: { glow: VIOLET, key: INDIGO, left: CYAN, right: PINK, level: 0.55, swell: 0.3, pace: 0.7, sparkle: 0.06 },
  question: { glow: INDIGO, key: CYAN, left: CYAN, right: VIOLET, level: 0.6, swell: 0.35, pace: 1.1, sparkle: 0.08 },
  spotlight: { glow: INDIGO, key: AMBER, left: AMBER, right: AMBER, level: 0.7, swell: 0.2, pace: 0.5, sparkle: 0 },
  wager: { glow: VIOLET, key: PINK, left: PINK, right: AMBER, level: 0.9, swell: 0.7, pace: 1.4, sparkle: 0.3 },
  think: { glow: INDIGO, key: VIOLET, left: CYAN, right: VIOLET, level: 0.5, swell: 0.45, pace: 0.6, sparkle: 0.12 },
  survey: { glow: VIOLET, key: CYAN, left: AMBER, right: PINK, level: 0.7, swell: 0.5, pace: 1, sparkle: 0.18 },
  standings: { glow: VIOLET, key: CYAN, left: CYAN, right: PINK, level: 0.65, swell: 0.4, pace: 0.8, sparkle: 0.15 },
  finale: { glow: VIOLET, key: AMBER, left: PINK, right: CYAN, level: 1, swell: 1, pace: 1.4, sparkle: 1 },
};

/** How the stage should be lit for what is on the screen. */
export function lightingFor(pub: PublicView): Lighting {
  if (pub.phase === 'lobby') return 'house';
  if (pub.phase === 'finished') return 'finale';
  if (pub.phase === 'standings') return 'standings';
  const round = pub.round;
  if (!round || round.stage === 'intro') return 'titles';
  switch (round.mode) {
    case 'trivia': {
      if (round.stage === 'roll') return 'titles';
      const clue = round.clue;
      if (!clue) return 'board';
      if (clue.stage === 'wager') return 'wager';
      if (clue.stage === 'answering') return 'spotlight';
      // The answer is up: the lights go back to where they were, and the ruling's own ripple says how it went.
      return clue.stage === 'result' ? 'board' : 'question';
    }
    case 'final':
      return round.stage === 'wager' ? 'wager' : round.stage === 'answering' ? 'think' : 'question';
    case 'fastMoney':
      return round.stage === 'answering' ? 'question' : 'survey';
  }
}

/** A ripple of light across the floor: its colour, how strong, and where it starts. */
export interface Ripple {
  color: Rgb;
  /** From a faint shimmer (near 0) to a wave the whole room sees (1). */
  strength: number;
  /** Under a player, wherever they are on the screen, or from the middle of the floor. */
  from: { player: string } | 'centre';
}

/** The ripple a moment in the game sets off, if it sets one off at all. */
export function rippleFor(event: GameEvent, pub: PublicView | null): Ripple | null {
  const centre = (color: Rgb, strength: number): Ripple => ({ color, strength, from: 'centre' });
  const under = (player: string, strength: number, color?: Rgb): Ripple => {
    const own = pub?.players.find((p) => p.id === player)?.avatar.color;
    return { color: color ?? (own ? rgb(own) : WHITE), strength, from: { player } };
  };
  switch (event.type) {
    case 'player.joined': return under(event.playerId, 0.7);
    case 'round.intro': return centre(VIOLET, 0.7);
    case 'category.changed': return centre(CYAN, 0.45);
    // An ordinary question opens the buzzers as it is picked, and that has a ripple of its own.
    case 'clue.selected': return event.wager ? centre(PINK, 1) : null;
    case 'buzz.open': return centre(GOOD, 0.55);
    case 'dice.rolled': return under(event.playerId, 0.5);
    case 'dice.won': return under(event.playerId, 1);
    case 'buzz.winner': return under(event.playerId, 1);
    case 'judged': return event.correct ? under(event.playerId, 1, GOOD) : under(event.playerId, 0.7, BAD);
    case 'timeup': return centre(BAD, 0.5);
    case 'wager.locked': return under(event.playerId, 0.4, PINK);
    case 'fm.reveal': return event.kind === 'answer' ? null : event.points > 0 ? centre(AMBER, 0.6) : centre(BAD, 0.5);
    case 'fm.result': return event.won ? centre(AMBER, 1) : null;
    case 'final.shown': return under(event.playerId, 0.45);
    case 'game.finished': return centre(AMBER, 1);
    case 'game.rematch': return centre(VIOLET, 0.8);
    case 'cue': return event.name === 'sad' ? centre(INDIGO, 0.6) : event.name === 'suspense' || event.name === 'drumroll' ? centre(PINK, 0.5) : centre(AMBER, 0.9);
    default: return null;
  }
}
