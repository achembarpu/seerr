import TheMovieDb from '@server/api/themoviedb';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

describe('TMDB search card lookups', () => {
  it('requests localized details without appended credits, trailers or providers', async () => {
    const tmdb = new TheMovieDb();
    const internal = tmdb as unknown as {
      get: (...args: unknown[]) => Promise<unknown>;
    };
    const get = mock.method(internal, 'get', async () => ({}));
    try {
      await tmdb.getMovieSearchDetails({ movieId: 603, language: 'ta' });
      await tmdb.getTvSearchDetails({ tvId: 1396, language: 'ml' });
      assert.deepEqual(get.mock.calls[0].arguments.slice(0, 2), [
        '/movie/603',
        { params: { language: 'ta' } },
      ]);
      assert.deepEqual(get.mock.calls[1].arguments.slice(0, 2), [
        '/tv/1396',
        { params: { language: 'ml' } },
      ]);
    } finally {
      get.mock.restore();
    }
  });

  it('requests appended keywords for Smart Search details and supports keyword-only lookups', async () => {
    const tmdb = new TheMovieDb();
    const internal = tmdb as unknown as {
      axios: { get: (url: string, config: unknown) => Promise<unknown> };
    };
    const movieKeywords = [{ id: 7, name: 'revenge' }];
    const tvKeywords = [{ id: 19, name: 'family' }];
    const get = mock.method(internal.axios, 'get', async (url: string) => ({
      data: url.endsWith('/keywords')
        ? url.startsWith('/movie')
          ? { keywords: movieKeywords }
          : { results: tvKeywords }
        : {},
    }));
    const { signal } = new AbortController();
    try {
      await tmdb.getSmartMovieDetails(603, 'ja', signal);
      await tmdb.getSmartTvDetails(1396, 'fr', signal);
      assert.deepEqual(
        await tmdb.getSmartKeywords('movie', 603, signal),
        movieKeywords
      );
      assert.deepEqual(
        await tmdb.getSmartKeywords('tv', 1396, signal),
        tvKeywords
      );
      assert.deepEqual(
        get.mock.calls.map((call) => call.arguments),
        [
          [
            '/movie/603',
            {
              signal,
              timeout: 30000,
              params: { language: 'ja', append_to_response: 'keywords' },
            },
          ],
          [
            '/tv/1396',
            {
              signal,
              timeout: 30000,
              params: { language: 'fr', append_to_response: 'keywords' },
            },
          ],
          ['/movie/603/keywords', { signal, timeout: 30000 }],
          ['/tv/1396/keywords', { signal, timeout: 30000 }],
        ]
      );
    } finally {
      get.mock.restore();
    }
  });
});
