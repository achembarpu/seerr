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
    assert.equal(response.body.results[0].matchScore, 0.9);
  });
  it('accepts two-character titles in scripts that use short words', async () => {
    const calls = indexMock.mock.callCount();
    await request(app)
      .get('/search/suggestions')
      .query({ query: '기생' })
      .expect(200);
    assert.equal(indexMock.mock.callCount(), calls + 1);
  });
  it('does not call the index for short input', async () => {
    const calls = indexMock.mock.callCount();
    await request(app)
      .get('/search/suggestions')
      .query({ query: 'm' })
      .expect(200);
    assert.equal(indexMock.mock.callCount(), calls);
  });
});

it('passes normal search and pagination directly to TMDB, including people', async () => {
  const tmdb = TheMovieDb.prototype as unknown as {
    get: (...args: unknown[]) => Promise<unknown>;
  };
  const get = mock.method(tmdb, 'get', async () => ({
    page: 3,
    total_pages: 5,
    total_results: 50,
    results: [
      {
        id: 42,
        media_type: 'person',
        name: 'An Actor',
        popularity: 1,
        adult: false,
        known_for: [],
      },
    ],
  }));
  try {
    const response = await request(app)
      .get('/search')
      .query({ query: 'example', page: '3', language: 'ta' })
      .expect(200);
    assert.equal(response.body.page, 3);
    assert.equal(response.body.results[0].mediaType, 'person');
    assert.equal(get.mock.callCount(), 1);
    assert.deepEqual(get.mock.calls[0].arguments[1], {
      params: {
        query: 'example',
        page: 3,
        include_adult: false,
        language: 'ta',
      },
    });
  } finally {
    get.mock.restore();
  }
});
