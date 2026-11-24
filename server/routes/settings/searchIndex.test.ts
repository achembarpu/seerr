import searchIndex from '@server/lib/searchIndex/service';
import { getSettings } from '@server/lib/settings';
import smartSearch from '@server/lib/smartSearch/service';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
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

describe('smart search settings API', () => {
  it('reports disabled status and refuses refresh through the OpenAPI validator', async () => {
    const response = await request(app)
      .get('/api/v1/settings/smart-search')
      .expect(200);
    assert.equal(response.body.enabled, false);
    assert.equal(response.body.phase, 'idle');
    await request(app)
      .post('/api/v1/settings/smart-search/refresh')
      .expect(409);
  });
});

it('updates reranking without changing existing search settings and restarts the runtime', async () => {
  const settings = getSettings();
  const before = { ...settings.main };
  const save = mock.method(settings, 'save', async () => undefined);
  const titleStart = mock.method(searchIndex, 'start', () => undefined);
  const titleRestart = mock.method(searchIndex, 'reconfigure', () => undefined);
  const restart = mock.method(smartSearch, 'reconfigure', () => undefined);
  try {
    const result = await request(app)
      .post('/api/v1/settings/main')
      .send({
        localTitleSearchRefreshInterval: 'weekly',
        smartSearchRerank: true,
        smartSearchLiveKeywords: false,
        smartSearchRerankCandidates: 80,
        smartSearchRefreshInterval: 'weekly',
      })
      .expect(200);
    assert.equal(result.body.localTitleSearchRefreshInterval, 'weekly');
    assert.equal(result.body.smartSearchLiveKeywords, false);
    assert.equal(titleRestart.mock.callCount(), 1);
    assert.equal(result.body.smartSearchRerank, true);
    assert.equal(result.body.smartSearchRerankCandidates, 80);
    assert.equal(result.body.smartSearchRefreshInterval, 'weekly');
    assert.equal(settings.main.smartSearch, before.smartSearch);
    assert.equal(settings.main.localTitleSearch, before.localTitleSearch);
    assert.equal(restart.mock.callCount(), 1);
    assert.equal(save.mock.callCount(), 1);
    await request(app)
      .post('/api/v1/settings/main')
      .send({ smartSearchRerank: 'yes' })
      .expect(400);
    await request(app)
      .post('/api/v1/settings/main')
      .send({ smartSearchRerankCandidates: 81 })
      .expect(400);
    await request(app)
      .post('/api/v1/settings/main')
      .send({ smartSearchRefreshInterval: 'hourly' })
      .expect(400);
    await request(app)
      .post('/api/v1/settings/main')
      .send({ localTitleSearchRefreshInterval: 'hourly' })
      .expect(400);
    assert.equal(save.mock.callCount(), 1);
  } finally {
    Object.assign(settings.main, before);
    save.mock.restore();
    titleStart.mock.restore();
    titleRestart.mock.restore();
    restart.mock.restore();
  }
});
