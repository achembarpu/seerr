import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieSearchDetails,
  TmdbSearchMovieResponse,
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
    }) as TmdbMovieSearchDetails
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
