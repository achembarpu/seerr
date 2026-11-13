import type { TmdbSearchMultiResponse } from '@server/api/themoviedb/interfaces';
import jaro from 'wink-jaro-distance';

type SearchResult = TmdbSearchMultiResponse['results'][number];
type SearchMulti = (options: {
  query: string;
  page: number;
  language?: string;
}) => Promise<TmdbSearchMultiResponse>;

const normalize = (value: string): string =>
  value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const similarity = (query: string, result: SearchResult): number => {
  const names =
    result.media_type === 'movie' || result.media_type === 'collection'
      ? [result.title, result.original_title]
      : result.media_type === 'tv'
        ? [result.name, result.original_name]
        : [result.name];

  const wordCount = query.split(' ').length;
  return Math.max(
    0,
    ...names.filter(Boolean).flatMap((name) => {
      const normalizedName = normalize(name);
      const words = normalizedName.split(' ');
      const phrases = words.map((_, index) =>
        words.slice(index, index + wordCount).join(' ')
      );
      return [normalizedName, ...phrases].map(
        (phrase) => jaro(query, phrase).similarity
      );
    })
  );
};

/** Retry an empty TMDB search with a few title prefixes, then choose the
 * candidate whose first page best matches the original query. Choosing one
 * candidate keeps TMDB's page counts and subsequent pages consistent.
 */
export const searchMedia = async ({
  search,
  query,
  page,
  language,
}: {
  search: SearchMulti;
  query: string;
  page: number;
  language?: string;
}): Promise<TmdbSearchMultiResponse> => {
  const original = await search({ query, page: 1, language });
  if (original.total_results > 0 || original.results.length > 0) {
    return page === 1 ? original : search({ query, page, language });
  }

  const normalizedQuery = normalize(query);
  const tokens = normalizedQuery
    .split(' ')
    .filter((token) => token.length >= 4);
  const prefixes = [
    ...new Set(
      tokens
        .sort((a, b) => b.length - a.length)
        .flatMap((token) => [token, token.slice(0, -1)])
        .filter((token) => token.length >= 3 && token !== normalizedQuery)
    ),
  ].slice(0, 4);
  const candidates = await Promise.all(
    prefixes.map(async (prefix) => ({
      query: prefix,
      response: await search({ query: prefix, page: 1, language }),
    }))
  );

  const best = candidates
    .map((candidate) => ({
      ...candidate,
      score: Math.max(
        0,
        ...candidate.response.results.map((result) =>
          similarity(normalizedQuery, result)
        )
      ),
    }))
    .sort((a, b) => b.score - a.score)[0];

  if (!best || best.score < 0.8) return original;
  if (page !== 1) return search({ query: best.query, page, language });

  return {
    ...best.response,
    results: [...best.response.results].sort(
      (a, b) => similarity(normalizedQuery, b) - similarity(normalizedQuery, a)
    ),
  };
};
