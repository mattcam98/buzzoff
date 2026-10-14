import type { GameEvent, PublicView } from '@buzzoff/shared';
import { describe, expect, it } from 'vitest';
import { lightingFor, LOOKS, rgb, rippleFor } from './lighting';

/** Only what the lighting reads of a game. */
const view = (over: object) => ({ phase: 'round', players: [], round: null, ...over }) as unknown as PublicView;
const trivia = (stage: string, clue: object | null = null) => view({ round: { mode: 'trivia', stage, clue } });

describe('lightingFor', () => {
  it('lights the lobby, the standings and the finish each their own way', () => {
    expect(lightingFor(view({ phase: 'lobby' }))).toBe('house');
    expect(lightingFor(view({ phase: 'standings' }))).toBe('standings');
    expect(lightingFor(view({ phase: 'finished' }))).toBe('finale');
  });

  it('follows a question from the board to the answer and back', () => {
    expect(lightingFor(trivia('intro'))).toBe('titles');
    expect(lightingFor(trivia('roll'))).toBe('titles');
    expect(lightingFor(trivia('board'))).toBe('board');
    expect(lightingFor(trivia('clue', { stage: 'wager' }))).toBe('wager');
    expect(lightingFor(trivia('clue', { stage: 'open' }))).toBe('question');
    expect(lightingFor(trivia('clue', { stage: 'answering' }))).toBe('spotlight');
    expect(lightingFor(trivia('clue', { stage: 'result' }))).toBe('board');
  });

  it('follows the final and a survey round', () => {
    const round = (mode: string, stage: string) => view({ round: { mode, stage } });
    expect(lightingFor(round('final', 'wager'))).toBe('wager');
    expect(lightingFor(round('final', 'answering'))).toBe('think');
    expect(lightingFor(round('final', 'reveal'))).toBe('question');
    expect(lightingFor(round('fastMoney', 'ready'))).toBe('survey');
    expect(lightingFor(round('fastMoney', 'answering'))).toBe('question');
    expect(lightingFor(round('fastMoney', 'result'))).toBe('survey');
  });

  it('keeps the floor quiet while there is a board or a question to read', () => {
    for (const busy of ['board', 'question', 'think'] as const) {
      expect(LOOKS[busy].level).toBeLessThan(LOOKS.titles.level);
      expect(LOOKS[busy].sparkle).toBeLessThan(LOOKS.house.sparkle);
    }
  });
});

describe('rippleFor', () => {
  const pub = view({ players: [{ id: 'p1', avatar: { emoji: '🐝', color: '#FF4D8D' } }] });

  it('starts a player’s ripple under them, in their own colour', () => {
    expect(rippleFor({ type: 'buzz.winner', playerId: 'p1' }, pub)).toEqual({ color: rgb('#FF4D8D'), strength: 1, from: { player: 'p1' } });
  });

  it('colours a ruling by how it went, not by who it was', () => {
    const right = rippleFor({ type: 'judged', playerId: 'p1', correct: true, delta: 100 }, pub)!;
    const wrong = rippleFor({ type: 'judged', playerId: 'p1', correct: false, delta: -100 }, pub)!;
    expect(right.color).toEqual(rgb('#58e88a'));
    expect(wrong.color).toEqual(rgb('#ff5c6c'));
    expect(right.from).toEqual({ player: 'p1' });
    expect(right.strength).toBeGreaterThan(wrong.strength);
  });

  it('still ripples for a player the screen has not heard of yet', () => {
    expect(rippleFor({ type: 'player.joined', playerId: 'new' }, null)).toMatchObject({ from: { player: 'new' } });
  });

  it('leaves alone what has a ripple from another event, and what is not a moment at all', () => {
    const quiet: GameEvent[] = [{ type: 'clue.selected', wager: false }, { type: 'fm.reveal', kind: 'answer' }, { type: 'clue.result' }, { type: 'paused', paused: true }];
    for (const event of quiet) expect(rippleFor(event, pub)).toBeNull();
    expect(rippleFor({ type: 'clue.selected', wager: true }, pub)).toMatchObject({ from: 'centre' });
  });
});
