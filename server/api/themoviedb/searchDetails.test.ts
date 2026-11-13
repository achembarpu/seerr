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
});
