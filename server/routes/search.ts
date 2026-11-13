import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbSearchMultiResponse,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import Media from '@server/entity/Media';
import { searchMedia } from '@server/lib/mediaSearch';
import { findSearchProvider } from '@server/lib/search';
import searchIndex from '@server/lib/searchIndex/service';
import logger from '@server/logger';
import {
  mapMovieDetailsToResult,
  mapSearchResults,
  mapTvDetailsToResult,
} from '@server/models/Search';
import { Router } from 'express';

const searchRoutes = Router();

searchRoutes.get('/suggestions', async (req, res) => {
  const query =
    typeof req.query.query === 'string' ? req.query.query.trim() : '';
  if (
    query.length < 3 ||
    query.length > 120 ||
    findSearchProvider(query.toLowerCase())
  )
    return res.status(200).json({ results: [] });
  try {
    const matches = await searchIndex.search(query);
    const tmdb = new TheMovieDb();
    const language = (req.query.language as string) ?? req.locale;
    const resolved = await Promise.allSettled(
      matches.map(
        async (match): Promise<TmdbMovieResult | TmdbTvResult | undefined> => {
          if (match.source === 'imdb') {
            const result = await tmdb.getByExternalId({
              externalId: match.sourceId,
              type: 'imdb',
              language,
            });
            const item =
              match.mediaType === 'movie'
                ? result.movie_results[0]
                : result.tv_results[0];
            return item
              ? ({ ...item, media_type: match.mediaType } as
                  | TmdbMovieResult
                  | TmdbTvResult)
              : undefined;
          }
          return match.mediaType === 'movie'
            ? mapMovieDetailsToResult(
                await tmdb.getMovieSearchDetails({
                  movieId: Number(match.sourceId),
                  language,
                })
              )
            : mapTvDetailsToResult(
                await tmdb.getTvSearchDetails({
                  tvId: Number(match.sourceId),
                  language,
                })
              );
        }
      )
    );
    const seen = new Set<string>();
    const results: (TmdbMovieResult | TmdbTvResult)[] = [];
    for (const value of resolved) {
      if (value.status !== 'fulfilled' || !value.value) continue;
      const result = value.value;
      const key = `${result.media_type}:${result.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(result);
      }
    }
    const media = await Media.getRelatedMedia(
      req.user,
      results.map((result) => ({
        tmdbId: result.id,
        mediaType: result.media_type,
      }))
    );
    return res.status(200).json({ results: mapSearchResults(results, media) });
  } catch (error) {
    logger.warn('Unable to retrieve local search suggestions', {
      label: 'Search',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return res.status(200).json({ results: [] });
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

      results = await searchMedia({
        search: tmdb.searchMulti,
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
