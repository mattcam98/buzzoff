/** Text as long as a field allows: `long(600)` is the longest question a pack may hold. */
const WORDS = ['quizzical', 'buzzers', 'at', 'the', 'ready', 'everybody'];
const words = (count: number) => Array.from({ length: count }, (_, i) => WORDS[i % WORDS.length]).join(' ');

export const long = (length: number, end = '?') => `${words(120).slice(0, length - 1).trimEnd()}${end}`;
