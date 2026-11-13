import TheMovieDb from '@server/api/themoviedb';
import Media from '@server/entity/Media';
import searchIndex from '@server/lib/searchIndex/service';
import express from 'express';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import request from 'supertest';
import searchRoutes from './search';

const app = express();
app.use('/search', searchRoutes);

describe('TMDB title suggestions', () => {
  it('maps basic movie and TV details to localized search cards', async () => {
    const index = mock.method(searchIndex, 'search', async () => [
      {
        source: 'tmdb-movie' as const,
        sourceId: '603',
        mediaType: 'movie' as const,
        title: 'Matrix',
        originalTitle: 'Matrix',
        popularity: 1,
        score: 1,
      },
      {
        source: 'tmdb-tv' as const,
        sourceId: '1396',
        mediaType: 'tv' as const,
        title: 'Example',
        originalTitle: 'Example',
        popularity: 1,
        score: 0.9,
      },
    ]);
    const movie = mock.method(
      TheMovieDb.prototype,
      'getMovieSearchDetails',
      async (options: { movieId: number; language?: string }) => ({
        id: 603,
        adult: false,
        genres: [{ id: 28, name: 'Action' }],
        original_language: 'en',
        original_title: 'The Matrix',
        overview: 'Overview',
        popularity: 1,
        release_date: '1999-01-01',
        title:
          options.language === 'ta' ? 'Matrix localized' : 'Wrong language',
        video: false,
        vote_average: 7,
        vote_count: 3,
      })
    );
    const tv = mock.method(
      TheMovieDb.prototype,
      'getTvSearchDetails',
      async (options: { tvId: number; language?: string }) => ({
        id: 1396,
        genres: [{ id: 18, name: 'Drama' }],
        original_language: 'en',
        original_name: 'Example',
        name:
          options.language === 'ta' ? 'Localized example' : 'Wrong language',
        first_air_date: '2008-01-01',
        origin_country: ['US'],
        overview: 'Overview',
        popularity: 1,
        vote_average: 7,
        vote_count: 3,
      })
    );
    const media = mock.method(Media, 'getRelatedMedia', async () => []);
    try {
      const response = await request(app)
        .get('/search/suggestions')
        .query({ query: 'matrix', language: 'ta' })
        .expect(200);
      assert.deepEqual(
        response.body.results.map(
          (item: { id: number; mediaType: string; genreIds: number[] }) => [
            item.id,
            item.mediaType,
            item.genreIds,
          ]
        ),
        [
          [603, 'movie', [28]],
          [1396, 'tv', [18]],
        ]
      );
      assert.equal(response.body.results[0].title, 'Matrix localized');
      assert.equal(response.body.results[1].name, 'Localized example');
      assert.equal(movie.mock.calls[0].arguments[0].language, 'ta');
      assert.equal(tv.mock.calls[0].arguments[0].language, 'ta');
    } finally {
      index.mock.restore();
      movie.mock.restore();
      tv.mock.restore();
      media.mock.restore();
    }
  });
});
