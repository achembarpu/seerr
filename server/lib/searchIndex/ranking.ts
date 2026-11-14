import jaro from 'wink-jaro-distance';

// Marks and joiners are meaningful in many scripts and must not be stripped.
export const normalizeTitle = (value: string): string =>
  value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\u200c\u200d]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

// Apply accent folding only to Latin letters; marks in other scripts can
// distinguish entirely different words. Collapse repeated letters for common
// spelling/transliteration variants, but keep the exact spelling as a signal.
const foldLatin = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC');

const collapseRepeatedLetters = (value: string): string => {
  let result = '';
  let previous = '';
  for (const char of value) {
    if (char !== previous || !/\p{L}/u.test(char)) result += char;
    previous = char;
  }
  return result;
};

/** Match quality for an entire title, with a discounted partial-word match. */
export const titleSimilarity = (query: string, title: string): number => {
  if (!query || !title) return 0;
  if (query === title) return 1;
  const foldedQuery = foldLatin(query);
  const foldedTitle = foldLatin(title);
  if (foldedQuery === foldedTitle) return 1;
  if (
    collapseRepeatedLetters(foldedQuery) ===
    collapseRepeatedLetters(foldedTitle)
  )
    return 0.98;
  let score = jaro(foldedQuery, foldedTitle).similarity;
  if (foldedTitle.includes(foldedQuery)) score = Math.max(score, 0.9);
  if (!foldedQuery.includes(' ')) {
    for (const word of foldedTitle.split(' ')) {
      if (Array.from(word).length < Array.from(foldedQuery).length * 0.6)
        continue;
      const wordScore = jaro(foldedQuery, word).similarity;
      // An exact word is useful ("matrix" / "the matrix"); a fuzzy word
      // inside a long title is weaker evidence than a full-title match.
      score = Math.max(score, word === foldedQuery ? 0.94 : wordScore * 0.88);
    }
  }
  return score;
};

export const titleRank = (score: number, popularity: number): number =>
  // An exact title must stay ahead of inexact matches regardless of votes.
  (score === 1 ? 1 : 0) +
  score +
  Math.min(0.06, Math.log10(Math.max(0, popularity) + 1) * 0.015);
