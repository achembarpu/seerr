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

/** Prepare query normalization once when ranking a candidate list. */
export const prepareTitleSimilarity = (query: string) => {
  const foldedQuery = foldLatin(query);
  const collapsedQuery = collapseRepeatedLetters(foldedQuery);
  const queryLength = Array.from(foldedQuery).length;
  const wordCount = foldedQuery.split(' ').length;
  return (title: string): number => {
    if (!query || !title) return 0;
    if (query === title) return 1;
    const foldedTitle = foldLatin(title);
    if (foldedQuery === foldedTitle) return 1;
    if (collapsedQuery === collapseRepeatedLetters(foldedTitle)) return 0.98;
    let score = jaro(foldedQuery, foldedTitle).similarity;
    if (foldedTitle.includes(foldedQuery)) score = Math.max(score, 0.9);
    if (wordCount > 1 && foldedQuery.length >= 7) {
      // A misspelling in the main title should still match a longer subtitle.
      const words = foldedTitle.split(' ', wordCount + 1);
      if (words.length > wordCount) {
        const prefix = words.slice(0, wordCount).join(' ');
        const prefixScore = jaro(foldedQuery, prefix).similarity;
        if (prefixScore >= 0.94)
          score = Math.max(score, Math.min(prefixScore, 0.99));
      }
    }
    if (wordCount === 1) {
      for (const word of foldedTitle.split(' ')) {
        if (Array.from(word).length < queryLength * 0.6) continue;
        const wordScore = jaro(foldedQuery, word).similarity;
        // Exact words in longer titles are stronger evidence than fuzzy words.
        score = Math.max(score, word === foldedQuery ? 0.94 : wordScore * 0.88);
      }
    }
    return score;
  };
};

export const titleSimilarity = (query: string, title: string): number =>
  prepareTitleSimilarity(query)(title);

export const titleRank = (score: number, popularity: number): number =>
  // An exact title must stay ahead of inexact matches regardless of votes.
  (score === 1 ? 1 : 0) +
  score +
  Math.min(0.06, Math.log10(Math.max(0, popularity) + 1) * 0.015);
