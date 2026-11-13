import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import request from 'supertest';
import settingsRoutes from './index';

const app = express();
app.use(express.json());
app.use(
  OpenApiValidator.middleware({
    apiSpec: path.resolve('seerr-api.yml'),
    validateRequests: true,
    validateSecurity: false,
  })
);
app.use('/api/v1/settings', settingsRoutes);

describe('search index settings API', () => {
  it('serves status through the OpenAPI validator and refuses a refresh while disabled', async () => {
    const status = await request(app)
      .get('/api/v1/settings/search-index')
      .expect(200);
    assert.equal(status.body.enabled, false);
    assert.equal(status.body.refreshing, false);
    assert.deepEqual(Object.keys(status.body.sources).sort(), [
      'imdb',
      'imdb-ratings',
      'tmdb-movie',
      'tmdb-tv',
    ]);
    await request(app)
      .post('/api/v1/settings/search-index/refresh')
      .expect(409);
  });
});
