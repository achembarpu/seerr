import * as datasource from '@server/datasource';
import Media from '@server/entity/Media';
import smartSearch from '@server/lib/smartSearch/service';
import express from 'express';
import assert from 'node:assert/strict';
import { after, it, mock } from 'node:test';
import request from 'supertest';
import searchRoutes from './search';

const app = express();
app.use((req, _res, next) => {
  req.user = { id: 42 } as typeof req.user;
  next();
});
app.use('/search', searchRoutes);
let options: unknown;
const repository = mock.method(datasource, 'getRepository', (() => ({
  find: async (value: unknown) => {
    options = value;
    return [{ media: { mediaType: 'movie', tmdbId: 15 } }];
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
