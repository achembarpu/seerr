import * as datasource from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import smartSearch from '@server/lib/smartSearch/service';
import express from 'express';
import assert from 'node:assert/strict';
import { after, it, mock } from 'node:test';
import request from 'supertest';
import searchRoutes from './search';

const app = express();
app.use((req, _res, next) => {
  req.user = { id: 42 } as typeof req.user;
  req.locale = 'fr';
  next();
});
app.use('/search', searchRoutes);
let options: unknown;
let requestRows: unknown[] = [];
let libraryRows: unknown[] = [];
const repository = mock.method(datasource, 'getRepository', ((
  entity: unknown
) => ({
  find: async (value: unknown) => {
    if (entity === MediaRequest) {
      options = value;
      return requestRows;
    }
    return libraryRows;
  },
})) as unknown as typeof datasource.getRepository);
const recommendations = mock.method(
  smartSearch,
  'recommendations',
  async () => []
);
const related = mock.method(Media, 'getRelatedMedia', async () => []);
after(() => {
  repository.mock.restore();
  recommendations.mock.restore();
  related.mock.restore();
});
it('only uses the current user’s request history for recommendations', async () => {
  requestRows = [{ media: { mediaType: 'movie', tmdbId: 15 } }];
  libraryRows = [];
  await request(app).get('/search/smart/recommendations').expect(200);
  assert.deepEqual(options, {
    where: { requestedBy: { id: 42 } },
    order: { createdAt: 'DESC' },
    take: 10,
  });
  assert.deepEqual(recommendations.mock.calls[0].arguments[0], [
    { type: 'movie', id: '15' },
  ]);
});

it('uses the shared library and user locale when there is no request history', async () => {
  requestRows = [];
  libraryRows = [{ mediaType: 'movie', tmdbId: 25 }];
  const response = await request(app)
    .get('/search/smart/recommendations')
    .expect(200);
  assert.equal(response.body.basis, 'none');
  assert.deepEqual(recommendations.mock.calls.at(-1)?.arguments[0], [
    { type: 'movie', id: '25' },
  ]);
  assert.equal(recommendations.mock.calls.at(-1)?.arguments[2], 'fr');
});
