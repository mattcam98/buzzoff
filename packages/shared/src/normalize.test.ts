import { describe, expect, it } from 'vitest';
import { editDistance, matchSurvey, normalizeAnswer, sameAnswer } from './normalize';

const answers = [
  { text: 'Brush teeth', points: 40, aliases: ['brushing teeth', 'toothbrush'] },
  { text: 'Coffee', points: 30, aliases: ['drink coffee', 'espresso'] },
  { text: 'Check phone', points: 20, aliases: ['look at phone', 'scroll'] },
  { text: 'Two eggs', points: 5, aliases: [] },
  { text: 'Bed', points: 5, aliases: [] },
];

describe('normalizeAnswer', () => {
  it.each([
    ['  The  Eiffel Tower!! ', 'eiffel tower'],
    ['Café au lait', 'cafe au lait'],
    ["Rock 'n' Roll", 'rock n roll'],
    ['Cats & Dogs', 'cat and dog'],
    ['boxes', 'box'],
    ['parties', 'party'],
    ['glass', 'glass'],
    ['three wishes', '3 wish'],
    ['The', 'the'],
    ['!!!', ''],
  ])('%s → %s', (input, expected) => expect(normalizeAnswer(input)).toBe(expected));
});

describe('matchSurvey', () => {
  it.each([
    ['brush my teeth', 0, 'exact'],
    ['BRUSHING TEETH', 0, 'exact'],
    ['coffe', 1, 'fuzzy'],
    ['Expresso', 1, 'fuzzy'],
    ['i drink some coffee first', 1, 'fuzzy'],
    ['checkphone', 2, 'exact'],
    ['2 eggs', 3, 'exact'],
  ] as const)('%s → answer %i (%s)', (input, index, kind) => expect(matchSurvey(input, answers)).toEqual({ index, kind }));

  it.each(['red', 'bad', 'tea', '', '   ', 'shower'])('does not match %j', (input) => expect(matchSurvey(input, answers)).toBeNull());
});

describe('helpers', () => {
  it('measures edit distance including transpositions', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('recieve', 'receive')).toBe(1);
    expect(editDistance('', 'abc')).toBe(3);
  });
  it('compares free-text answers loosely but never matches blanks', () => {
    expect(sameAnswer('The Beatles', 'beatles')).toBe(true);
    expect(sameAnswer('', '')).toBe(false);
  });
});
