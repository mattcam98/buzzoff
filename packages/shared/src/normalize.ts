/**
 * Answer normalisation and survey matching for typed answers.
 *
 * Matching is intentionally conservative and always reports *how* it matched,
 * so the host can see which matches were inexact and override them before the
 * points are revealed.
 */
import type { SurveyAnswer } from './content';

const STOPWORDS = new Set(['the', 'a', 'an', 'my', 'your', 'our', 'their', 'his', 'her', 'some', 'of', 'to']);
const UNITS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUMBER_WORDS: Record<string, string> = {
  zero: '0', ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
  seventeen: '17', eighteen: '18', nineteen: '19', hundred: '100', thousand: '1000',
  ...Object.fromEntries(Object.entries({ ...UNITS, ...TENS }).map(([word, n]) => [word, String(n)])),
};

/** Number words as figures, so that "eighteen" is 18 and "twenty-seven" is 27 rather than a 20 and a 7. */
function numerals(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const tens = TENS[words[i]];
    const unit = UNITS[words[i + 1]];
    if (tens && unit) out.push(String(tens + unit)), i++;
    else out.push(NUMBER_WORDS[words[i]] ?? words[i]);
  }
  return out;
}

function singular(word: string): string {
  // "cookies" becomes "cooky" below, so "cookie" has to as well.
  if (word.length >= 3 && word.endsWith('ie')) return word.slice(0, -2) + 'y';
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (/(ch|sh|ss|x|z)es$/.test(word)) return word.slice(0, -2);
  // Only consistency matters here, not grammar: both sides of a comparison are normalised the same way.
  if (word.endsWith('s') && !/(ss|us)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Lower-case, strip accents/punctuation/filler words, and singularise. */
export function normalizeAnswer(input: string): string {
  const cleaned = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    // Letters and digits of any script are kept, so an answer in Greek or Japanese can match too.
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!cleaned) return '';
  const words = numerals(cleaned.split(' '));
  const meaningful = words.filter((w) => !STOPWORDS.has(w));
  return (meaningful.length ? meaningful : words).map(singular).join(' ');
}

/** Optimal-string-alignment edit distance (insert, delete, substitute, transpose). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev2: number[] = [];
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

/** Typos tolerated for a phrase of the given length. Short answers must be exact. */
const allowedTypos = (len: number) => (len < 5 ? 0 : len < 9 ? 1 : 2);

const containsPhrase = (haystack: string, needle: string) => ` ${haystack} `.includes(` ${needle} `);

export type MatchKind = 'exact' | 'fuzzy';
export interface SurveyMatch {
  index: number;
  kind: MatchKind;
}

/**
 * Find which survey answer (if any) a typed response corresponds to.
 * Order of preference: exact normalised match, small typo, then the response
 * containing an accepted phrase as whole words ("eating pizza" -> "pizza").
 */
export function matchSurvey(response: string, answers: readonly SurveyAnswer[]): SurveyMatch | null {
  const norm = normalizeAnswer(response);
  if (!norm) return null;
  const compact = norm.replace(/ /g, '');
  const candidates = answers.map((a) => [a.text, ...a.aliases].map(normalizeAnswer).filter(Boolean));
  // A number is not a spelling. "9 times" is not a slip of the finger for "8 times", and "20 million" does not
  // become "a million" by having the word in it: for an answer that is a number, a loose match needs the same digits.
  const digits = (text: string) => text.replace(/\D/g, '');
  const sameNumber = (i: number, c: string) => !/\d/.test(candidates[i][0] ?? '') || digits(c) === digits(norm);

  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].some((c) => c === norm || c.replace(/ /g, '') === compact)) return { index: i, kind: 'exact' };
  }

  let best: { index: number; distance: number } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    for (const c of candidates[i]) {
      const limit = allowedTypos(Math.min(c.length, norm.length));
      if (!limit || Math.abs(c.length - norm.length) > limit || !sameNumber(i, c)) continue;
      const d = editDistance(c, norm);
      if (d <= limit && (!best || d < best.distance)) best = { index: i, distance: d };
    }
  }
  if (best) return { index: best.index, kind: 'fuzzy' };

  let longest: { index: number; length: number } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    for (const c of candidates[i]) {
      if (c.length >= 4 && containsPhrase(norm, c) && sameNumber(i, c) && (!longest || c.length > longest.length)) {
        longest = { index: i, length: c.length };
      }
    }
  }
  return longest ? { index: longest.index, kind: 'fuzzy' } : null;
}

/** True when two free-text answers are the same once normalised. */
export const sameAnswer = (a: string, b: string) => {
  const na = normalizeAnswer(a);
  return na !== '' && na === normalizeAnswer(b);
};
