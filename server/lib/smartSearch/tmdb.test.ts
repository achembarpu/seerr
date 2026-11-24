import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbSearchMovieResponse,
  TmdbSmartMovieDetails,
} from '@server/api/themoviedb/interfaces';
import assert from 'node:assert/strict';
import { after, it, mock } from 'node:test';
import { TmdbMetadataSource } from './tmdb';

const discover = mock.method(
  TheMovieDb.prototype,
  'getSmartDiscover',
  async () =>
    ({
      page: 1,
      total_pages: 1,
      total_results: 1,
      results: [
        {
          id: 12,
          media_type: 'movie',
          title: 'Example',
          original_title: 'Example',
          original_language: 'ja',
          overview: '',
          genre_ids: [18],
          adult: false,
          video: false,
          release_date: '2020-01-01',
          popularity: 3,
          vote_average: 7,
          vote_count: 20,
        },
      ],
    }) as TmdbSearchMovieResponse
);
const details = mock.method(
  TheMovieDb.prototype,
  'getSmartMovieDetails',
  async (_id: number, language: string) =>
    ({
      id: 12,
      title: 'Example',
      original_title: 'Example',
      original_language: 'ja',
      overview: language === 'ja' ? 'A localized description' : '',
      genres: [{ id: 18, name: 'Drama' }],
      adult: false,
      video: false,
      release_date: '2020-01-01',
      popularity: 3,
      vote_average: 7,
      vote_count: 20,
      ...(language === 'en-US' && {
        keywords: {
          keywords: [
            { id: 1, name: ' family secret ' },
            { id: 2, name: 'family secret' },
          ],
        },
      }),
    }) as TmdbSmartMovieDetails
);
after(() => {
  discover.mock.restore();
  details.mock.restore();
});
it('uses original-language descriptions when English is unavailable', async () => {
  const source = new TmdbMetadataSource();
  const page = await source.fetchPage('movie', '2020-01-01', '2020-12-31', 1);
  assert.equal(page.documents.length, 1);
  assert.equal(page.documents[0].overview, 'A localized description');
  assert.equal(page.documents[0].originalLanguage, 'ja');
  assert.deepEqual(
    details.mock.calls.map((call) => call.arguments[1]),
    ['ja']
  );
});

it('retains appended movie keywords when only the localized details have a synopsis', async () => {
  const source = new TmdbMetadataSource();
  const document = await source.fetchOne('movie', '12');
  assert.equal(document?.overview, 'A localized description');
  assert.deepEqual(document?.keywords, ['family secret']);
  assert.deepEqual(
    details.mock.calls.slice(-2).map((call) => call.arguments[1]),
    ['en-US', 'ja']
  );
});

it('uses the TV keyword list and preserves an empty list', async (context) => {
  const tmdb = new TheMovieDb();
  context.mock.method(tmdb, 'getSmartTvDetails', async (id: number) => ({
    id,
    genres: [],
    name: 'Series',
    original_name: 'Series',
    original_language: 'en',
    overview: 'An example synopsis.',
    keywords: { results: id === 12 ? [{ id: 1, name: 'workplace' }] : [] },
  }));

  const source = new TmdbMetadataSource(tmdb);
  assert.deepEqual((await source.fetchOne('tv', '12'))?.keywords, [
    'workplace',
  ]);
  assert.deepEqual((await source.fetchOne('tv', '13'))?.keywords, []);
});

it('distinguishes unavailable, empty, and retryable keyword-only lookups', async (context) => {
  const tmdb = new TheMovieDb();
  const gone = { isAxiosError: true, response: { status: 404 } };
  const rateLimited = { isAxiosError: true, response: { status: 429 } };
  const request = context.mock.method(
    tmdb,
    'getSmartKeywords',
    async (_type: string, id: number) => {
      if (id === 1) return [{ id: 12, name: 'ensembles ' }];
      if (id === 2) return [];
      if (id === 3) return undefined;
      if (id === 4) throw gone;
      throw rateLimited;
    }
  );
  const source = new TmdbMetadataSource(tmdb);
  const { signal } = new AbortController();
  assert.deepEqual(await source.fetchKeywords('movie', '1', signal), [
    'ensembles',
  ]);
  assert.deepEqual(await source.fetchKeywords('movie', '2'), []);
  assert.equal(await source.fetchKeywords('tv', '3'), undefined);
  assert.deepEqual(await source.fetchKeywords('tv', '4'), []);
  await assert.rejects(
    source.fetchKeywords('tv', '5'),
    (error) => error === rateLimited
  );
  assert.deepEqual(request.mock.calls[0].arguments, ['movie', 1, signal]);
});
