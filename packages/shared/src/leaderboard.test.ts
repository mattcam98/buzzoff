import { describe, expect, it } from 'vitest';
import { buildLeaderboard, mergeProblem, rankPlayers, type LeaderboardEntry } from './leaderboard';
import { emptyStats, type PlayerStats } from './state';
import type { GameResult, ResultPlayer } from './stats';

const AVATAR = { emoji: '🐝', color: '#FFC400' } as const;

type Seat = { name: string; score: number; profileId?: string; champion?: boolean; stats?: Partial<PlayerStats> };

let clock = 0;
/** A finished game. The top score is the champion unless a seat says otherwise; games are dated in the order they are made. */
function game(id: string, seats: Seat[]): GameResult {
  const best = Math.max(...seats.map((s) => s.score));
  const players = seats
    .map((s): ResultPlayer => ({
      ...(s.profileId ? { profileId: s.profileId } : {}),
      name: s.name, avatar: AVATAR, score: s.score, team: null, eliminated: false,
      champion: s.champion ?? s.score === best, stats: { ...emptyStats(), ...s.stats },
    }))
    .sort((a, b) => Number(b.champion) - Number(a.champion) || b.score - a.score);
  clock += 1000;
  return { id, code: 'BZZT', name: `Night ${id}`, packTitles: [], startedAt: clock - 500, finishedAt: clock, rounds: [], players, teams: null };
}

const board = (results: GameResult[], links = {}) => {
  const { players, games } = buildLeaderboard(results, links);
  return { games, by: (name: string) => players.find((p) => p.name === name)!, players };
};

describe('adding games up', () => {
  it('totals wins, points and buzzer statistics for a returning player', () => {
    const { games, by } = board([
      game('1', [
        { name: 'Ann', profileId: 'a', score: 600, stats: { buzzes: 4, buzzMsTotal: 2000, buzzWins: 3, fastestMs: 310, correct: 3, incorrect: 0 } },
        { name: 'Bo', profileId: 'b', score: 200, stats: { buzzes: 4, buzzMsTotal: 2800, buzzWins: 1, fastestMs: 520, correct: 1, incorrect: 1 } },
      ]),
      game('2', [
        { name: 'Ann', profileId: 'a', score: 100, stats: { buzzes: 2, buzzMsTotal: 1600, buzzWins: 0, fastestMs: 640, correct: 0, incorrect: 1, surveyPoints: 12 } },
        { name: 'Bo', profileId: 'b', score: 500, stats: { buzzes: 2, buzzMsTotal: 700, buzzWins: 2, fastestMs: 300, correct: 2, incorrect: 0 } },
      ]),
    ]);
    expect(games).toBe(2);
    expect(by('Ann')).toMatchObject({
      games: 2, wins: 1, points: 700, best: 600,
      stats: { buzzes: 6, buzzMsTotal: 3600, buzzWins: 3, fastestMs: 310, correct: 3, incorrect: 1, surveyPoints: 12 },
    });
    expect(by('Bo')).toMatchObject({ games: 2, wins: 1, points: 700, stats: { fastestMs: 300 } });
    expect(by('Ann').recent.map((g) => [g.name, g.place, g.of, g.won])).toEqual([['Night 2', 2, 2, false], ['Night 1', 1, 2, true]]);
  });

  it('leaves out practice: a game with one player, or one where nothing was played', () => {
    const { games, players } = board([
      game('solo', [{ name: 'Ann', profileId: 'a', score: 900 }]),
      game('abandoned', [{ name: 'Ann', profileId: 'a', score: 0 }, { name: 'Bo', profileId: 'b', score: 0 }]),
    ]);
    expect(games).toBe(0);
    expect(players).toEqual([]);
  });

  it('gives no win when there was nobody to beat', () => {
    // A dead heat makes everyone a champion; so does a team game with one team.
    const { by } = board([game('1', [{ name: 'Ann', profileId: 'a', score: 300 }, { name: 'Bo', profileId: 'b', score: 300 }])]);
    expect(by('Ann')).toMatchObject({ games: 1, wins: 0 });
    expect(by('Ann').recent[0]).toMatchObject({ place: 1, won: false });
  });

  it('counts every member of the winning team as a winner', () => {
    const { by } = board([
      game('1', [
        { name: 'Ann', profileId: 'a', score: 100, champion: true },
        { name: 'Bo', profileId: 'b', score: 500, champion: true },
        { name: 'Cy', profileId: 'c', score: 550, champion: false },
      ]),
    ]);
    expect([by('Ann').wins, by('Bo').wins, by('Cy').wins]).toEqual([1, 1, 0]);
    expect(by('Cy').recent[0].place).toBe(3);
  });
});

describe('recognising players', () => {
  it('follows a phone through a change of name and shows the latest one', () => {
    const { players } = board([
      game('1', [{ name: 'Matthew', profileId: 'm', score: 100 }, { name: 'Bo', profileId: 'b', score: 50 }]),
      game('2', [{ name: 'Matt', profileId: 'm', score: 100 }, { name: 'Bo', profileId: 'b', score: 50 }]),
      game('3', [{ name: 'El Matto', profileId: 'm', score: 100 }, { name: 'Bo', profileId: 'b', score: 50 }]),
    ]);
    expect(players).toHaveLength(2);
    expect(players.find((p) => p.id === 'm')).toMatchObject({ name: 'El Matto', aliases: ['Matt', 'Matthew'], games: 3, wins: 3 });
  });

  it('keeps two people apart when they happen to pick the same name', () => {
    const { players } = board([
      game('1', [{ name: 'Sam', profileId: 's1', score: 100 }, { name: 'Bo', profileId: 'b', score: 50 }]),
      game('2', [{ name: 'Sam', profileId: 's2', score: 100 }, { name: 'Bo', profileId: 'b', score: 50 }]),
    ]);
    expect(players.filter((p) => p.name === 'Sam').map((p) => p.games)).toEqual([1, 1]);
  });

  it('matches games from before players were recognised by name, ignoring case and spacing', () => {
    const { players, by } = board([
      game('old', [{ name: 'ann', score: 100 }, { name: 'Bo', score: 50 }]),
      game('older', [{ name: 'A N N', score: 100 }, { name: 'Bo', score: 50 }]),
      game('new', [{ name: 'Ann', profileId: 'a', score: 100 }, { name: 'Bo', score: 50 }]),
    ]);
    expect(players).toHaveLength(2);
    expect(by('Ann')).toMatchObject({ id: 'a', games: 3, wins: 3 });
    expect(by('Bo')).toMatchObject({ id: 'name:bo', games: 3 });
  });

  it('does not guess when a name could be either of two people', () => {
    const { players } = board([
      game('old', [{ name: 'Sam', score: 100 }, { name: 'Bo', profileId: 'b', score: 50 }]),
      game('2', [{ name: 'Sam', profileId: 's1', score: 100 }, { name: 'Bo', profileId: 'b', score: 50 }]),
      game('3', [{ name: 'Sam', profileId: 's2', score: 100 }, { name: 'Bo', profileId: 'b', score: 50 }]),
    ]);
    expect(players.map((p) => p.id).sort()).toEqual(['b', 'name:sam', 's1', 's2']);
  });

  it('never counts one person twice in a game', () => {
    const { players, by } = board([
      // Ann's profile once played as "Kit". Here she plays as Ann against somebody else called Kit.
      game('1', [{ name: 'Kit', profileId: 'a', score: 100 }, { name: 'Bo', profileId: 'b', score: 50 }]),
      game('2', [{ name: 'Ann', profileId: 'a', score: 100 }, { name: 'Kit', score: 50 }]),
    ]);
    expect(players).toHaveLength(3);
    expect(by('Ann').games).toBe(2);
    expect(by('Kit')).toMatchObject({ id: 'name:kit', games: 1 });
  });

  it('handles one phone holding two seats: a seat left behind is dropped, a second player is known by name', () => {
    const { by, players } = board([
      game('ghost', [{ name: 'Ann', profileId: 'a', score: 300 }, { name: 'Annn', profileId: 'a', score: 0 }, { name: 'Bo', profileId: 'b', score: 100 }]),
      game('shared', [{ name: 'Ann', profileId: 'a', score: 300 }, { name: 'Kid', profileId: 'a', score: 200, stats: { correct: 2 } }]),
    ]);
    expect(players.map((p) => p.name).sort()).toEqual(['Ann', 'Bo', 'Kid']);
    expect(by('Ann')).toMatchObject({ games: 2, wins: 2 });
    expect(by('Ann').recent[1].of).toBe(2);
    expect(by('Kid')).toMatchObject({ id: 'name:kid', games: 1 });
  });
});

describe('the host deciding who is who', () => {
  const results = () => [
    game('1', [{ name: 'Matt', profileId: 'phone', score: 100 }, { name: 'Bo', profileId: 'b', score: 50 }]),
    game('2', [{ name: 'Matty', profileId: 'tablet', score: 20 }, { name: 'Bo', profileId: 'b', score: 50 }]),
    game('3', [{ name: 'Matt', profileId: 'phone', score: 100 }, { name: 'Bo', profileId: 'b', score: 50 }, { name: 'Cy', score: 10 }]),
  ];

  it('merges two entries into one and lists what went into it', () => {
    const list = results();
    expect(mergeProblem(list, {}, 'tablet', 'phone')).toBeNull();
    const { players } = board(list, { tablet: 'phone' });
    expect(players).toHaveLength(3);
    const matt = players.find((p) => p.id === 'phone')!;
    expect(matt).toMatchObject({ name: 'Matt', aliases: ['Matty'], games: 3, wins: 2, points: 220 });
    expect(matt.identities).toEqual([{ id: 'phone', name: 'Matt', games: 2 }, { id: 'tablet', name: 'Matty', games: 1 }]);
  });

  it('follows a chain of merges and survives a loop', () => {
    const list = ['x', 'y', 'z'].map((id) => game(id, [{ name: id, profileId: id, score: 100 }, { name: 'Bo', profileId: 'b', score: 50 }]));
    expect(board(list, { x: 'y', y: 'z' }).players.find((p) => p.id === 'z')).toMatchObject({ games: 3, aliases: ['y', 'x'] });
    expect(board(list, { x: 'y', y: 'x' }).players.map((p) => p.id).sort()).toEqual(['b', 'x', 'y', 'z']);
  });

  it('stops applying a merge in a game where both turn up', () => {
    // The host merged the tablet into the phone, and later both sat down to the same game.
    const list = [...results(), game('4', [{ name: 'Matt', profileId: 'phone', score: 100 }, { name: 'Matty', profileId: 'tablet', score: 50 }])];
    const { players } = board(list, { tablet: 'phone' });
    expect(players.find((p) => p.id === 'phone')).toMatchObject({ games: 4 });
    expect(players.find((p) => p.id === 'tablet')).toMatchObject({ games: 1 });
  });

  it('refuses to merge two people who have played each other', () => {
    expect(mergeProblem(results(), {}, 'phone', 'b')).toMatch(/same game/);
    expect(mergeProblem(results(), {}, 'phone', 'phone')).toMatch(/different/);
    expect(mergeProblem(results(), {}, 'phone', 'nobody')).toMatch(/no longer/);
  });

  it('keeps a name apart from the profile it would otherwise match', () => {
    const list = [
      game('old', [{ name: 'Sam', score: 100 }, { name: 'Bo', profileId: 'b', score: 50 }]),
      game('new', [{ name: 'Sam', profileId: 's', score: 100 }, { name: 'Bo', profileId: 'b', score: 50 }]),
    ];
    expect(board(list).players).toHaveLength(2);
    expect(board(list, { 'name:sam': 'name:sam' }).players.map((p) => p.id).sort()).toEqual(['b', 'name:sam', 's']);
  });
});

describe('ranking', () => {
  const entry = (name: string, games: number, wins: number, extra: Partial<LeaderboardEntry> = {}): LeaderboardEntry => ({
    id: name, name, avatar: AVATAR, aliases: [], games, wins, points: 0, best: 0, stats: emptyStats(), lastPlayedAt: 0, recent: [], identities: [], ...extra,
  });
  const order = (r: ReturnType<typeof rankPlayers>) => r.rows.map((row) => `${row.rank ?? '–'}${row.tied ? '=' : ''} ${row.entry.name}`);

  it('orders by wins, breaks ties on win rate, and lets equals share a rank', () => {
    const players = [entry('Dee', 2, 0), entry('Ann', 5, 3), entry('Bo', 4, 3), entry('Cy', 9, 2), entry('Eve', 2, 0)];
    expect(order(rankPlayers(players, 'wins'))).toEqual(['1 Bo', '2 Ann', '3 Cy', '4= Dee', '4= Eve']);
  });

  it('ranks a rate only once there is enough play behind it', () => {
    const players = [entry('Ann', 10, 6), entry('Bo', 1, 1), entry('Cy', 3, 2), entry('Dee', 2, 0)];
    const ranking = rankPlayers(players, 'winRate');
    expect(ranking).toMatchObject({ minimum: 3, unit: 'game' });
    expect(order(ranking)).toEqual(['1 Cy', '2 Ann', '– Bo', '– Dee']);
  });

  it('asks for no more than the busiest player has managed, so a new league is ranked from its first night', () => {
    const ranking = rankPlayers([entry('Ann', 1, 1), entry('Bo', 1, 0)], 'winRate');
    expect(ranking.minimum).toBe(1);
    expect(order(ranking)).toEqual(['1 Ann', '2 Bo']);
  });

  it('ranks the buzzer on how often a buzz got in first, and accuracy on judged answers', () => {
    const stats = (s: Partial<PlayerStats>) => ({ stats: { ...emptyStats(), ...s } });
    const players = [
      entry('Quick', 3, 0, stats({ buzzes: 20, buzzWins: 12, buzzMsTotal: 9000, correct: 6, incorrect: 6 })),
      entry('Sure', 3, 0, stats({ buzzes: 12, buzzWins: 6, buzzMsTotal: 9000, correct: 11, incorrect: 1 })),
      entry('Shy', 3, 0, stats({ buzzes: 2, buzzWins: 2, buzzMsTotal: 600, correct: 2, incorrect: 0 })),
    ];
    expect(order(rankPlayers(players, 'buzzer'))).toEqual(['1 Quick', '2 Sure', '– Shy']);
    expect(order(rankPlayers(players, 'accuracy'))).toEqual(['1 Sure', '2 Quick', '– Shy']);
  });

  it('has nothing to say about an empty leaderboard', () => {
    expect(rankPlayers([], 'wins')).toEqual({ rows: [], minimum: 1, unit: 'game' });
  });
});
