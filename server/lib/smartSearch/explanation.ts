import type { MatchExplanation } from '@server/models/Search';
import type { SmartMatch } from './store';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const commonWords = new Set([
  'about',
  'avec',
  'dans',
  'film',
  'from',
  'have',
  'movie',
  'series',
  'show',
  'sobre',
  'that',
  'their',
  'they',
  'this',
  'when',
  'where',
  'with',
  'what',
  'which',
  'who',
  'une',
  'der',
  'die',
  'das',
  'und',
]);

function* words(text: string) {
  for (const part of segmenter.segment(text.normalize('NFC'))) {
    if (part.isWordLike) yield part.segment.toLowerCase();
  }
}

export function explainMatch(
  match: SmartMatch,
  queryTerms: readonly string[] = [],
  basis?: 'requests' | 'library'
): MatchExplanation {
  const methods = match.methods ?? [];
  const wanted = new Set(queryTerms);
  const terms = new Set<string>();
  if (wanted.size) {
    for (const word of words(match.document.overview)) {
      if (wanted.has(word)) terms.add(word);
      if (terms.size >= 3) break;
    }
  }
  const tmdb = methods.includes('tmdb-keyword')
    ? 'keywords'
    : methods.some(
          (method) =>
            method === 'tmdb-similar' || method === 'tmdb-recommendation'
        )
      ? 'related'
      : undefined;
  return {
    description: methods.includes('semantic') || undefined,
    lexical: methods.includes('lexical') || undefined,
    tmdb,
    terms: terms.size ? [...terms] : undefined,
    seedTitle: match.seedTitle || undefined,
    basis,
    sharedGenreIds: match.sharedGenreIds?.length
      ? match.sharedGenreIds
      : undefined,
  };
}

export const explanationTerms = (query: string): string[] =>
  [...new Set(words(query))].filter(
    (word) =>
      !commonWords.has(word) &&
      (/^[\p{Script=Latin}\p{N}]+$/u.test(word)
        ? word.length >= 4
        : Array.from(word).length >= 2)
  );
