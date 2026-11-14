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

export type SearchMethod = 'title' | 'approximate' | 'semantic';
export type SearchItem = (MovieResult | TvResult | PersonResult) & {
  matchMethods?: SearchMethod[];
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

/** Combine sources by media type and TMDB ID, retaining every match reason. */
export const mergeResults = (
  query: string,
  regular: SearchItem[],
  approximate: SearchItem[],
  semantic: SearchItem[],
  filters: SearchFilters
): SearchItem[] => {
  const normalized = normalizeTitle(query);
  const merged = new Map<
    string,
    { item: SearchItem; rank: number; titleScore: number; order: number }
  >();
  let order = 0;
  const decisiveTitle = [...regular, ...approximate].some(
    (item) =>
      matchesFilters(item, filters) &&
      (Math.max(titleScore(normalized, item), item.matchScore ?? 0) >= 0.94 ||
        compactScriptTitleScore(normalized, item) >= 0.75)
  );
  let extraSemantic = 0;
  for (const [method, items] of [
    ['title', regular],
    ['approximate', approximate],
    ['semantic', semantic],
  ] as const) {
    items.forEach((item, position) => {
      if (!matchesFilters(item, filters)) return;
      const key = `${item.mediaType}:${item.id}`;
      const score = Math.max(
        titleScore(normalized, item),
        method === 'approximate' ? (item.matchScore ?? 0) : 0
      );
      // Source scores use different scales. Fuse positions instead of assuming
      // that a weak fuzzy title is always better than a description match.
      // Strong title evidence remains a separate signal for title lookups.
      const weight =
        method === 'semantic'
          ? 1.5
          : semantic.length && !decisiveTitle
            ? 0.3
            : 1;
      const contribution = weight / (position + 3);
      const compactScore =
        method === 'approximate'
          ? compactScriptTitleScore(normalized, item)
          : 0;
      const titleEvidence =
        compactScore >= 0.75
          ? Math.max(score, 0.94 + (compactScore - 0.75) * 0.2)
          : score;
      const existing = merged.get(key);
      if (
        method === 'semantic' &&
        !existing &&
        decisiveTitle &&
        extraSemantic++ >= 5
      )
        return;
      if (existing) {
        if (!existing.item.matchMethods?.includes(method)) {
          existing.item.matchMethods?.push(method);
          existing.rank += contribution;
        }
        existing.titleScore = Math.max(existing.titleScore, titleEvidence);
      } else {
        merged.set(key, {
          item: { ...item, matchMethods: [method] },
          rank: contribution,
          titleScore: titleEvidence,
          order: order++,
        });
      }
    });
  }
  return [...merged.values()]
    .sort((a, b) => {
      const aTitle = a.titleScore >= 0.94 ? 3 + a.titleScore : 0;
      const bTitle = b.titleScore >= 0.94 ? 3 + b.titleScore : 0;
      return bTitle - aTitle || b.rank - a.rank || a.order - b.order;
    })
    .map(({ item }) => item);
};
