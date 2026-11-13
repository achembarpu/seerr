import TheMovieDb from '@server/api/themoviedb';
import type { TmdbExternalIdResponse } from '@server/api/themoviedb/interfaces';
import Media from '@server/entity/Media';
import searchIndex from '@server/lib/searchIndex/service';
import express from 'express';
import assert from 'node:assert/strict';
import { after, describe, it, mock } from 'node:test';
import request from 'supertest';
import searchRoutes from './search';

const app = express();
app.use('/search', searchRoutes);
const indexMock = mock.method(searchIndex, 'search', async () => [
  {
    source: 'imdb' as const,
    sourceId: 'tt10687070',
    mediaType: 'movie' as const,
    title: 'Mandela',
    originalTitle: 'Mandela',
    popularity: 100,
    score: 0.9,
  },
  {
    source: 'imdb' as const,
    sourceId: 'tt2',
    mediaType: 'movie' as const,
    title: 'Mandela',
    originalTitle: 'Mandela',
    popularity: 10,
    score: 0.9,
  },
]);
const findMock = mock.method(
  TheMovieDb.prototype,
  'getByExternalId',
  async () =>
    ({
      movie_results: [
        {
          id: 806067,
          media_type: 'movie',
          title: 'Mandela',
          adult: false,
          video: false,
          release_date: '2021-01-01',
          original_language: 'ta',
          original_title: 'Mandela',
          genre_ids: [],
          overview: 'A village election',
          popularity: 1,
          vote_average: 1,
          vote_count: 1,
        },
      ],
      tv_results: [],
      person_results: [],
    }) as TmdbExternalIdResponse
);
const mediaMock = mock.method(Media, 'getRelatedMedia', async () => []);
after(() => {
  indexMock.mock.restore();
  findMock.mock.restore();
  mediaMock.mock.restore();
});

describe('local title suggestions', () => {
  it('returns a deduplicated media suggestion for a misspelled title', async () => {
    const response = await request(app)
      .get('/search/suggestions')
      .query({ query: 'mandla' })
      .expect(200);
    assert.equal(response.body.results.length, 1);
    assert.equal(response.body.results[0].id, 806067);
    assert.equal(response.body.results[0].mediaType, 'movie');
  });
  it('does not call the index for short input', async () => {
    const calls = indexMock.mock.callCount();
    await request(app)
      .get('/search/suggestions')
      .query({ query: 'ma' })
      .expect(200);
    assert.equal(indexMock.mock.callCount(), calls);
  });
});
