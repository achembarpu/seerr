import TheMovieDb from '@server/api/themoviedb';
import type { TmdbSearchMultiResponse } from '@server/api/themoviedb/interfaces';
import { MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { findSearchProvider } from '@server/lib/search';
import searchIndex from '@server/lib/searchIndex/service';
import {
  explainMatch,
  explanationTerms,
} from '@server/lib/smartSearch/explanation';
import smartSearch from '@server/lib/smartSearch/service';
import type { SmartMatch } from '@server/lib/smartSearch/store';
import type {
  SmartFilters,
  SmartMediaType,
} from '@server/lib/smartSearch/types';
import logger from '@server/logger';
import type { MovieResult, TvResult } from '@server/models/Search';
import {
  mapMovieDetailsToResult,
  mapMovieResult,
  mapSearchResults,
  mapTvDetailsToResult,
  mapTvResult,
} from '@server/models/Search';
import { Router } from 'express';
import { LRUCache } from 'lru-cache';

const searchRoutes = Router();

const smartFilters = (query: Record<string, unknown>): SmartFilters => {
  const numeric = (name: string): number | undefined => {
    const value = query[name];
    if (typeof value !== 'string' && typeof value !== 'number')
      return undefined;
    if (typeof value === 'string' && !value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    mediaType:
      query.mediaType === 'movie' || query.mediaType === 'tv'
        ? query.mediaType
        : undefined,
    language:
      typeof query.originalLanguage === 'string' && query.originalLanguage
        ? query.originalLanguage
        : undefined,
    yearFrom: numeric('yearFrom'),
    yearTo: numeric('yearTo'),
    genre: numeric('genre'),
    minRating: numeric('minRating'),
    minVotes: numeric('minVotes'),
  };
};

type MediaCard = MovieResult | TvResult;

const attachMediaInfo = async (
  cards: MediaCard[],
  user: User | undefined,
  includeActiveRequest = false
) => {
  const related = await Media.getRelatedMedia(
    user,
    cards.map((card) => ({ tmdbId: card.id, mediaType: card.mediaType })),
    { includeActiveRequest }
  );
  return cards.map((card) => ({
    ...card,
    mediaInfo: related.find(
      (media) => media.tmdbId === card.id && media.mediaType === card.mediaType
    ),
  }));
};

const smartCards = (
  matches: SmartMatch[],
  user: User | undefined,
  context: {
    query?: string;
    basis?: 'requests' | 'library';
    related?: boolean;
  } = {}
) => {
  const terms = context.query ? explanationTerms(context.query) : [];
  return attachMediaInfo(
    matches.map((match) => ({
      ...(match.document.card as unknown as MediaCard),
      matchExplanation: explainMatch(match, terms, context.basis),
    })),
    user,
    context.related
  );
};

// Preserve localized, resolved cards across overlapping queries. User-specific
// request, watchlist and availability status is always attached afterwards.
const titleCards = new LRUCache<string, MediaCard | false>({
  max: 2048,
  ttl: 60 * 60 * 1000,
});

searchRoutes.get('/smart', async (req, res, next) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once('close', abort);
  try {
    const query =
      typeof req.query.query === 'string' ? req.query.query.trim() : '';
    const status = smartSearch.status();
    if (!query || !status.enabled)
      return res.status(200).json({
        results: [],
        enabled: status.enabled,
        ready: status.count > 0,
      });
    const matches = await smartSearch.search(
      query.slice(0, 500),
      smartFilters(req.query),
      (req.query.language as string) ?? req.locale,
      controller.signal
    );
    const results = (
      await smartCards(matches, req.user, { query: query.slice(0, 500) })
    ).map((card, index) => ({
      ...card,
      matchScore: matches[index].score,
      searchMethods: matches[index].methods,
      reranked: matches[index].reranked ?? false,
    }));
    return res
      .status(200)
      .json({ results, enabled: true, ready: smartSearch.status().count > 0 });
  } catch (error) {
    if (!controller.signal.aborted) return next(error);
  } finally {
    res.off('close', abort);
  }
});

searchRoutes.get('/smart/recommendations', async (req, res, next) => {
  try {
    if (!req.user)
      return res.status(401).json({ message: 'User missing from request.' });
    const requests = await getRepository(MediaRequest).find({
      where: { requestedBy: { id: req.user.id } },
      order: { createdAt: 'DESC' },
      take: 10,
    });
    const seeds = requests
      .filter(
        (request) =>
          request.media?.tmdbId &&
          (request.media.mediaType === 'movie' ||
            request.media.mediaType === 'tv')
      )
      .map((request) => ({
        type: request.media.mediaType as SmartMediaType,
        id: String(request.media.tmdbId),
      }));
    let basis: 'requests' | 'library' | 'none' = seeds.length
      ? 'requests'
      : 'none';
    let matches = seeds.length
      ? await smartSearch.recommendations(
          seeds,
          smartFilters(req.query),
          req.locale
        )
      : [];
    if (!matches.length) {
      const library = await getRepository(Media).find({
        where: [
          { status: MediaStatus.AVAILABLE },
          { status: MediaStatus.PARTIALLY_AVAILABLE },
        ],
        order: { mediaAddedAt: 'DESC' },
        take: 10,
      });
      const librarySeeds = library
        .filter(
          (media) =>
            media.tmdbId &&
            (media.mediaType === 'movie' || media.mediaType === 'tv')
        )
        .map((media) => ({
          type: media.mediaType as SmartMediaType,
          id: String(media.tmdbId),
        }));
      matches = librarySeeds.length
        ? await smartSearch.recommendations(
            librarySeeds,
            smartFilters(req.query),
            req.locale
          )
        : [];
      basis = matches.length ? 'library' : 'none';
    }
    const results = await smartCards(matches, req.user, {
      related: true,
      basis: basis === 'none' ? undefined : basis,
    });
    return res.status(200).json({
      page: 1,
      totalPages: 1,
      totalResults: results.length,
      results,
      basis,
    });
  } catch (error) {
    return next(error);
  }
});

searchRoutes.get('/smart/similar', async (req, res, next) => {
  try {
    const type = req.query.mediaType as SmartMediaType;
    const matches = await smartSearch.similar(
      type,
      String(req.query.id),
      smartFilters(req.query),
      (req.query.language as string) ?? req.locale
    );
    const results = await smartCards(matches, req.user, { related: true });
    return res
      .status(200)
      .json({ page: 1, totalPages: 1, totalResults: results.length, results });
  } catch (error) {
    return next(error);
  }
});

searchRoutes.get('/suggestions', async (req, res) => {
  const query =
    typeof req.query.query === 'string' ? req.query.query.trim() : '';
  if (
    Array.from(query).length < 2 ||
    query.length > 120 ||
    findSearchProvider(query.toLowerCase())
  )
    return res.status(200).json({ results: [] });
  try {
    const matches = await searchIndex.search(query, 40);
    const tmdb = new TheMovieDb();
    const language = (req.query.language as string) ?? req.locale;
    const localCards = new Map<string, MediaCard>();
    await Promise.all(
      (['movie', 'tv'] as const).map(async (type) => {
        const ids = matches
          .filter(
            (match) => match.source !== 'imdb' && match.mediaType === type
          )
          .map((match) => match.sourceId);
        if (!ids.length) return;
        const indexed = await smartSearch
          .indexedTitleCards(type, ids, language ?? 'en')
          .catch(() => []);
        for (const { sourceId, card } of indexed)
          localCards.set(`${type}:${sourceId}`, card as unknown as MediaCard);
      })
    );

    const results: MediaCard[] = [];
    const scores: number[] = [];
    const seen = new Set<string>();
    // Most requests resolve in one wave. Keep scanning past invalid mappings
    // and duplicates, preserving fuzzy rank regardless of response order.
    for (
      let offset = 0;
      offset < matches.length && results.length < 15;
      offset += 20
    ) {
      const batch = matches.slice(offset, offset + 20);
      const resolved = await Promise.allSettled(
        batch.map(async (match): Promise<MediaCard | false> => {
          const { source, mediaType, sourceId } = match;
          const id = `${mediaType}:${sourceId}`;
          const key = JSON.stringify([language, source, id]);
          const cached = titleCards.get(key);
          if (cached !== undefined) return cached;
          const local = source !== 'imdb' ? localCards.get(id) : undefined;
          // The indexed card is already current enough for search and needs no
          // per-title request. Don't cache it independently of the index.
          if (local) return local;
          let card: MediaCard | false;
          if (source === 'imdb') {
            const result = await tmdb.getByExternalId({
              externalId: sourceId,
              type: 'imdb',
              language,
            });
            card =
              mediaType === 'movie'
                ? !!result.movie_results[0] &&
                  mapMovieResult(result.movie_results[0])
                : !!result.tv_results[0] && mapTvResult(result.tv_results[0]);
          } else {
            card =
              mediaType === 'movie'
                ? mapMovieResult(
                    mapMovieDetailsToResult(
                      await tmdb.getMovieSearchDetails({
                        movieId: Number(sourceId),
                        language,
                      })
                    )
                  )
                : mapTvResult(
                    mapTvDetailsToResult(
                      await tmdb.getTvSearchDetails({
                        tvId: Number(sourceId),
                        language,
                      })
                    )
                  );
          }
          titleCards.set(key, card, card ? undefined : { ttl: 5 * 60 * 1000 });
          return card;
        })
      );
      for (const [index, value] of resolved.entries()) {
        if (value.status !== 'fulfilled' || !value.value) continue;
        const card = value.value;
        const key = `${card.mediaType}:${card.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(card);
        scores.push(batch[index].score);
        if (results.length === 15) break;
      }
    }

    const cards = await attachMediaInfo(results, req.user);
    return res.status(200).json({
      results: cards.map((card, index) => ({
        ...card,
        matchScore: scores[index],
      })),
    });
  } catch (error) {
    logger.warn('Unable to retrieve local search suggestions', {
      label: 'Search',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return res
      .status(503)
      .json({ results: [], message: 'Local title search is unavailable.' });
  }
});

searchRoutes.get('/', async (req, res, next) => {
  const queryString = req.query.query as string;
  const searchProvider = findSearchProvider(queryString.toLowerCase());
  let results: TmdbSearchMultiResponse;

  try {
    if (searchProvider) {
      const [id] = queryString
        .toLowerCase()
        .match(searchProvider.pattern) as RegExpMatchArray;
      results = await searchProvider.search({
        id,
        language: (req.query.language as string) ?? req.locale,
        query: queryString,
      });
    } else {
      const tmdb = new TheMovieDb();

      results = await tmdb.searchMulti({
        query: queryString,
        page: Number(req.query.page) || 1,
        language: (req.query.language as string) ?? req.locale,
      });
    }

    const media = await Media.getRelatedMedia(
      req.user,
      results.results.map((result) => ({
        tmdbId: result.id,
        mediaType: result.media_type,
      }))
    );

    return res.status(200).json({
      page: results.page,
      totalPages: results.total_pages,
      totalResults: results.total_results,
      results: mapSearchResults(results.results, media),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving search results', {
      label: 'API',
      errorMessage: e.message,
      query: req.query.query,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve search results.',
    });
  }
});

searchRoutes.get('/keyword', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.searchKeyword({
      query: req.query.query as string,
      page: Number(req.query.page),
    });

    return res.status(200).json(results);
  } catch (e) {
    logger.debug('Something went wrong retrieving keyword search results', {
      label: 'API',
      errorMessage: e.message,
      query: req.query.query,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve keyword search results.',
    });
  }
});

searchRoutes.get('/company', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.searchCompany({
      query: req.query.query as string,
      page: Number(req.query.page),
    });

    return res.status(200).json(results);
  } catch (e) {
    logger.debug('Something went wrong retrieving company search results', {
      label: 'API',
      errorMessage: e.message,
      query: req.query.query,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve company search results.',
    });
  }
});

export default searchRoutes;
