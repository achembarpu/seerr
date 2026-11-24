import {
  normalizeTitle,
  titleSimilarity,
} from '@server/lib/searchIndex/ranking';
import type {
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import type { SearchFilters } from './SmartSearch';

export type SearchItem = (MovieResult | TvResult | PersonResult) & {
  matchScore?: number;
};

const titleScore = (query: string, item: SearchItem): number => {
  const names =
    item.mediaType === 'movie'
      ? [item.title, item.originalTitle]
      : item.mediaType === 'tv'
        ? [item.name, item.originalName]
        : [item.name];
  return Math.max(
    0,
    ...names.map((name) => titleSimilarity(query, normalizeTitle(name ?? '')))
  );
};

// For very short non-Latin titles, one changed character leaves little
// similarity evidence. A same-length full-title match is stronger than a
// partial match elsewhere in a long title, even with a lower raw score.
const compactScriptTitleScore = (query: string, item: SearchItem): number => {
  const length = Array.from(query).length;
  if (
    length < 2 ||
    length > 4 ||
    query.includes(' ') ||
    !/[^\p{ASCII}]/u.test(query)
  )
    return 0;
  const names =
    item.mediaType === 'movie'
      ? [item.title, item.originalTitle]
      : item.mediaType === 'tv'
        ? [item.name, item.originalName]
        : [item.name];
  return Math.max(
    0,
    ...names.map((name) => {
      const normalized = normalizeTitle(name ?? '');
      return !normalized.includes(' ') &&
        Array.from(normalized).length === length
        ? titleSimilarity(query, normalized)
        : 0;
    })
  );
};

export const matchesFilters = (
  item: SearchItem,
  filters: SearchFilters
): boolean => {
  if (filters.type && item.mediaType !== filters.type) return false;
  if (item.mediaType === 'person')
    return ![
      filters.language,
      filters.yearFrom,
      filters.yearTo,
      filters.rating,
      filters.votes,
      filters.genre,
    ].some(Boolean);
  const year = Number(
    (item.mediaType === 'movie' ? item.releaseDate : item.firstAirDate)?.slice(
      0,
      4
    )
  );
  return (
    (!filters.language || item.originalLanguage === filters.language) &&
    (!filters.genre || item.genreIds?.includes(Number(filters.genre))) &&
    (!filters.yearFrom || (!!year && year >= Number(filters.yearFrom))) &&
    (!filters.yearTo || (!!year && year <= Number(filters.yearTo))) &&
    (!filters.rating || item.voteAverage >= Number(filters.rating)) &&
    (!filters.votes || item.voteCount >= Number(filters.votes))
  );
};

export const resultKey = (item: SearchItem) => `${item.mediaType}:${item.id}`;

export const isDirectLookup = (query: string) =>
  /(?:tmdb:|tvdb:)\d+|imdb:(?:tt|nm)\d+|year:\d{4}/i.test(query);

/** Rank title and alias evidence independently of the description search. */
export const rankTitleResults = (
  query: string,
  regular: SearchItem[],
  approximate: SearchItem[],
  filters: SearchFilters
) => {
  const normalized = normalizeTitle(query);
  const entries = new Map<
    string,
    { item: SearchItem; rank: number; evidence: number }
  >();
  for (const source of [regular, approximate]) {
    source.forEach((item, position) => {
      if (!matchesFilters(item, filters)) return;
      const key = resultKey(item);
      const existing = entries.get(key);
      const compact = compactScriptTitleScore(normalized, item);
      const evidence = Math.max(
        titleScore(normalized, item),
        item.matchScore ?? 0,
        compact >= 0.75 ? 0.94 + (compact - 0.75) * 0.2 : 0
      );
      entries.set(key, {
        // The regular result includes current localized TMDB metadata.
        item: existing?.item ?? item,
        rank: (existing?.rank ?? 0) + 1 / (position + 3),
        evidence: Math.max(existing?.evidence ?? 0, evidence),
      });
    });
  }
  const ranked = [...entries.values()].sort(
    (a, b) =>
      (b.evidence >= 0.94 ? b.evidence : 0) -
        (a.evidence >= 0.94 ? a.evidence : 0) || b.rank - a.rank
  );
  return {
    all: ranked.map(({ item }) => item),
    credible: ranked
      .filter(({ evidence }) => evidence >= 0.9)
      .map(({ item }) => item),
    confident: ranked.some(({ item, evidence }) =>
      item.mediaType === 'person' ? evidence === 1 : evidence >= 0.94
    ),
  };
};

export const descriptionResults = (
  matches: SearchItem[],
  titleItems: SearchItem[],
  filters: SearchFilters
) => {
  const seen = new Set(titleItems.map(resultKey));
  return matches.filter((item) => {
    const key = resultKey(item);
    if (seen.has(key) || !matchesFilters(item, filters)) return false;
    seen.add(key);
    return true;
  });
};
