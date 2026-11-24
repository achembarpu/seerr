import {
  normalizeTitle,
  prepareTitleSimilarity,
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

const titleNames = (item: SearchItem): string[] =>
  (item.mediaType === 'movie'
    ? [item.title, item.originalTitle]
    : item.mediaType === 'tv'
      ? [item.name, item.originalName]
      : [item.name]
  ).map((name) => normalizeTitle(name ?? ''));

// For very short non-Latin titles, one changed character leaves little
// similarity evidence. A same-length full-title match is stronger than a
// partial match elsewhere in a long title, even with a lower raw score.
const compactScriptTitleScore = (query: string, titles: string[]): number => {
  const length = Array.from(query).length;
  if (
    length < 2 ||
    length > 4 ||
    query.includes(' ') ||
    !/[^\p{ASCII}]/u.test(query)
  )
    return 0;
  return Math.max(
    0,
    ...titles.map((title) => {
      return !title.includes(' ') && Array.from(title).length === length
        ? titleSimilarity(query, title)
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

type TitleMatch = {
  item: SearchItem;
  evidence: number;
  pin: boolean;
};

/** Rank title and alias evidence independently of the description search. */
export const rankTitleResults = (
  query: string,
  regular: SearchItem[],
  approximate: SearchItem[],
  filters: SearchFilters
) => {
  const normalized = normalizeTitle(query);
  const matchTitle = prepareTitleSimilarity(normalized);
  const entries = new Map<string, TitleMatch & { rank: number }>();
  for (const source of [regular, approximate]) {
    source.forEach((item, position) => {
      if (!matchesFilters(item, filters)) return;
      const key = resultKey(item);
      const existing = entries.get(key);
      const names = titleNames(item);
      const compact = compactScriptTitleScore(normalized, names);
      const similarity = Math.max(0, ...names.map(matchTitle));
      const evidence = Math.max(
        similarity,
        item.matchScore ?? 0,
        compact >= 0.75 ? 0.94 + (compact - 0.75) * 0.2 : 0
      );
      // An exact word anywhere in a longer title can score 0.94. Reserve
      // pinning for stronger matches and short, same-length script typos.
      const pin =
        item.mediaType === 'person'
          ? similarity === 1
          : evidence > 0.94 || compact >= 0.75;
      entries.set(key, {
        // The regular result includes current localized TMDB metadata.
        item: existing?.item ?? item,
        rank: (existing?.rank ?? 0) + 1 / (position + 3),
        evidence: Math.max(existing?.evidence ?? 0, evidence),
        pin: !!existing?.pin || pin,
      });
    });
  }
  return [...entries.values()].sort(
    (a, b) =>
      (b.evidence >= 0.94 ? b.evidence : 0) -
        (a.evidence >= 0.94 ? a.evidence : 0) || b.rank - a.rank
  );
};

const mergeCardDetails = (
  title: SearchItem,
  semantic: SearchItem
): SearchItem =>
  title.mediaType === 'person' || semantic.mediaType === 'person'
    ? title
    : {
        ...title,
        overview: title.overview || semantic.overview,
        posterPath: title.posterPath ?? semantic.posterPath,
        mediaInfo: title.mediaInfo ?? semantic.mediaInfo,
        matchExplanation: semantic.matchExplanation ?? title.matchExplanation,
      };

/** Combine rank positions because the title and semantic scores use different scales. */
export const mergeSearchResults = (
  titles: TitleMatch[],
  descriptions: SearchItem[],
  filters: SearchFilters
) => {
  const entries = new Map<string, TitleMatch & { score: number }>();
  titles.forEach((match, position) => {
    entries.set(resultKey(match.item), {
      ...match,
      score: (0.25 + 0.5 * match.evidence) / (10 + position),
    });
  });
  const seen = new Set<string>();
  let position = 0;
  for (const item of descriptions) {
    const key = resultKey(item);
    if (seen.has(key) || !matchesFilters(item, filters)) continue;
    seen.add(key);
    const score = 1 / (10 + position++);
    const title = entries.get(key);
    entries.set(
      key,
      title
        ? {
            ...title,
            item: mergeCardDetails(title.item, item),
            score: title.score + score,
          }
        : { item, evidence: 0, pin: false, score }
    );
  }
  return [...entries.values()]
    .sort(
      (a, b) =>
        Number(b.pin) - Number(a.pin) ||
        (a.pin && b.pin ? b.evidence - a.evidence : 0) ||
        b.score - a.score
    )
    .map(({ item }) => item);
};
