import type { PersonCreditCast } from '@server/models/Person';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankCredits } from './credits';

function credit(id: number, overrides: Partial<PersonCreditCast> = {}) {
  return {
    id,
    adult: false,
    character: 'Cast member',
    creditId: String(id),
    episodeCount: 0,
    firstAirDate: '',
    mediaType: 'movie',
    name: '',
    originCountry: [],
    originalLanguage: 'en',
    originalName: '',
    originalTitle: '',
    overview: '',
    popularity: 0,
    releaseDate: '',
    title: '',
    voteAverage: 0,
    voteCount: 0,
    ...overrides,
  } satisfies PersonCreditCast;
}

const character = (item: PersonCreditCast) => item.character;

test('ranks a well-rated credit ahead of a lower-rated hit and a sparse perfect rating', () => {
  const credits = [
    credit(1, { voteAverage: 10, voteCount: 2 }),
    credit(2, { voteAverage: 5.8, voteCount: 10000 }),
    credit(3, { voteAverage: 8.1, voteCount: 650 }),
  ];

  assert.deepEqual(
    rankCredits(credits, 'all', 'top', character).map(({ id }) => id),
    [3, 2, 1]
  );
});

test('groups roles by both media type and ID, retaining movie and series with overlapping IDs', () => {
  const credits = [
    credit(1, { character: 'First role' }),
    credit(1, { character: 'First role' }),
    credit(1, { character: 'Second role' }),
    credit(1, { mediaType: 'tv', character: 'TV role' }),
    credit(2, { mediaType: undefined }),
  ];

  assert.deepEqual(
    rankCredits(credits, 'all', 'top', character).map(
      ({ mediaType, roles }) => [mediaType, roles]
    ),
    [
      ['movie', 'First role, Second role'],
      ['tv', 'TV role'],
    ]
  );
  assert.deepEqual(
    rankCredits(credits, 'tv', 'top', character).map(({ roles }) => roles),
    ['TV role']
  );
});

test('keeps a clear newest-first view, placing undated credits last', () => {
  const credits = [
    credit(1, { voteAverage: 8.9, voteCount: 1080, releaseDate: '1995-01-01' }),
    credit(2, { mediaType: 'tv', firstAirDate: '2022-08-10' }),
    credit(3, { voteAverage: 9, voteCount: 2900 }),
  ];

  assert.deepEqual(
    rankCredits(credits, 'all', 'newest', character).map(({ id }) => id),
    [2, 1, 3]
  );
});

test('uses TV episode participation as a small tie-break for equally rated shows', () => {
  const credits = [
    credit(1, {
      mediaType: 'tv',
      episodeCount: 1,
      voteAverage: 7.8,
      voteCount: 1000,
    }),
    credit(2, {
      mediaType: 'tv',
      episodeCount: 12,
      voteAverage: 7.8,
      voteCount: 1000,
    }),
    credit(3, {
      mediaType: 'tv',
      episodeCount: 1,
      voteAverage: 8.5,
      voteCount: 1000,
    }),
  ];

  assert.deepEqual(
    rankCredits(credits, 'all', 'top', character).map(({ id }) => id),
    [3, 2, 1]
  );
});

test('favors a director’s own credit over a close producing credit', () => {
  const credits = [
    {
      ...credit(1, { voteAverage: 8.0, voteCount: 1600 }),
      department: 'Production',
      job: 'Executive Producer',
    },
    {
      ...credit(2, { voteAverage: 7.9, voteCount: 1600 }),
      department: 'Directing',
      job: 'Director',
    },
  ];

  assert.deepEqual(
    rankCredits(credits, 'all', 'top', (item) => item.job, 'Directing').map(
      ({ id }) => id
    ),
    [2, 1]
  );
});
