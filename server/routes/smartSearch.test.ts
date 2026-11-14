import Media from '@server/entity/Media';
import smartSearch from '@server/lib/smartSearch/service';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, it, mock } from 'node:test';
import request from 'supertest';
import searchRoutes from './search';

const app = express();
app.use(
  OpenApiValidator.middleware({
    apiSpec: path.resolve('seerr-api.yml'),
    validateRequests: true,
    validateSecurity: false,
  })
);
app.use('/api/v1/search', searchRoutes);
const status = mock.method(smartSearch, 'status', () => ({
  enabled: true,
  phase: 'ready' as const,
  indexing: false,
  count: 1,
  cursor: undefined,
  error: undefined,
  nextRefreshAt: undefined,
  downloadBytes: 0,
  downloadTotal: 1,
}));
const search = mock.method(smartSearch, 'search', async () => [
  {
    score: 0.9,
    document: {
      source: 'tmdb',
      sourceId: '1',
      mediaType: 'movie' as const,
      title: 'Example',
      overview: 'A mystery',
      originalLanguage: 'fr',
      year: 2020,
      genreIds: [9648],
      voteAverage: 7,
      voteCount: 20,
      popularity: 2,
      card: {
        id: 1,
        mediaType: 'movie',
        title: 'Example',
        originalTitle: 'Example',
        overview: 'A mystery',
        genreIds: [9648],
        originalLanguage: 'fr',
        voteAverage: 7,
        voteCount: 20,
        popularity: 2,
        adult: false,
        video: false,
        releaseDate: '2020-01-01',
      },
    },
  },
]);
const related = mock.method(Media, 'getRelatedMedia', async () => []);
after(() => {
  status.mock.restore();
  search.mock.restore();
  related.mock.restore();
});

it('passes structured filters through the validated smart search endpoint', async () => {
  const response = await request(app)
    .get('/api/v1/search/smart')
    .query({
      query: 'a mystery',
      mediaType: 'movie',
      originalLanguage: 'fr',
      minRating: 7,
      yearFrom: 2019,
    })
    .expect(200);
  assert.equal(response.body.results[0].title, 'Example');
  assert.deepEqual(search.mock.calls[0].arguments[1], {
    mediaType: 'movie',
    language: 'fr',
    yearFrom: 2019,
    yearTo: undefined,
    genre: undefined,
    minRating: 7,
    minVotes: undefined,
  });
  await request(app)
    .get('/api/v1/search/smart')
    .query({ query: 'test', minRating: 11 })
    .expect(400);
});
