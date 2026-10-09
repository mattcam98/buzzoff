import type { PublicPlayer } from '@buzzoff/shared';
import { describe, expect, it } from 'vitest';
import { placings } from './format';

const player = (id: string, score: number): PublicPlayer => ({
  id, name: id, avatar: { emoji: '🐝', color: '#FFC400' }, score, teamId: null, ready: true, eliminated: false, connected: true,
});
const table = (players: PublicPlayer[], champions: string[] | null = null) => placings(players, champions).map(({ player: p, place }) => `${place} ${p.id}`);

describe('placings', () => {
  it('gives players who are level the same place, and skips the places they take up', () => {
    expect(table([player('ann', 0), player('bob', 0), player('cat', 0)])).toEqual(['1 ann', '1 bob', '1 cat']);
    expect(table([player('ann', 200), player('bob', 500), player('cat', 200), player('dan', -100)])).toEqual(['1 bob', '2 ann', '2 cat', '4 dan']);
  });

  it('puts the champions first once the game is over, whatever the scores say', () => {
    // A decider crowned Cat from second on the board.
    expect(table([player('ann', 900), player('bob', 300), player('cat', 600)], ['cat'])).toEqual(['1 cat', '2 ann', '3 bob']);
    // Team mates win together, and the two who are level behind them share third.
    expect(table([player('ann', 100), player('bob', 700), player('cat', 400), player('dan', 400)], ['ann', 'bob'])).toEqual(['1 bob', '1 ann', '3 cat', '3 dan']);
  });
});
