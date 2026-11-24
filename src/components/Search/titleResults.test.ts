import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { SearchFilters } from './SmartSearch';
import {
  descriptionResults,
  isDirectLookup,
  matchesFilters,
  rankTitleResults,
  type SearchItem,
} from './titleResults';

const filters: SearchFilters = {
  type: '',
  language: '',
  yearFrom: '',
  yearTo: '',
  rating: '',
  votes: '',
  genre: '',
};
const movie = (id: number, title: string, extra: object = {}): SearchItem => ({
  id,
  mediaType: 'movie',
  title,
  originalTitle: title,
  popularity: 1,
  voteCount: 100,
  voteAverage: 8,
  genreIds: [18],
  overview: '',
  originalLanguage: 'en',
  releaseDate: '2020-01-01',
  adult: false,
  video: false,
  ...extra,
});
const person: SearchItem = {
  id: 1,
  mediaType: 'person',
  name: 'Maveran Person',
  popularity: 1,
  adult: false,
  knownFor: [],
};

it('ranks the close title ahead of people and deduplicates regular and alias results', () => {
  const localized = movie(1, 'Maaveeran', { posterPath: '/poster.jpg' });
  const result = rankTitleResults(
    'maveran',
    [person, localized, movie(2, 'Another Film')],
    [movie(1, 'Maaveeran', { matchScore: 0.98 })],
    filters
  );
  assert.equal(result.all[0], localized);
  assert.equal(result.all.length, 3);
  assert.equal(result.confident, true);
});

it('shares filters across title and description results and keeps title IDs out of descriptions', () => {
  const applied = { ...filters, language: 'en', rating: '7' };
  assert.equal(matchesFilters(person, applied), false);
  const title = movie(1, 'Maaveeran');
  const titles = rankTitleResults('maveran', [title, person], [], applied);
  assert.deepEqual(titles.all, [title]);
  const other = movie(2, 'Another story');
  assert.deepEqual(
    descriptionResults(
      [
        title,
        other,
        other,
        movie(3, 'French title', { originalLanguage: 'fr' }),
      ],
      titles.all,
      applied
    ),
    [other]
  );
  assert.equal(matchesFilters(title, { ...filters, yearFrom: '2021' }), false);
});

it('keeps weak title guesses out of the way for plot queries', () => {
  const { all, credible, confident } = rankTitleResults(
    'barber murderers',
    [person],
    [
      movie(1, 'Bizarre Murders', { matchScore: 0.86 }),
      movie(2, 'Barber', { matchScore: 0.79 }),
    ],
    filters
  );
  assert.equal(confident, false);
  assert.equal(all.length, 3);
  assert.deepEqual(credible, []);
});

it('retains compact non-Latin matches and partial title matches', () => {
  const parasite = movie(496243, 'Parasite', {
    originalTitle: '기생충',
    matchScore: 0.778,
  });
  const ranked = rankTitleResults('기생총', [], [parasite], filters);
  assert.deepEqual(ranked.credible, [parasite]);
  assert.equal(ranked.confident, true);
  const matrix = movie(603, 'The Matrix');
  assert.deepEqual(rankTitleResults('matr', [matrix], [], filters).credible, [
    matrix,
  ]);
});

it('recognizes direct ID searches and year lookups', () => {
  for (const lookup of [
    'IMDb:tt0133093',
    'TMDB:603',
    'tvdb:121361',
    'year:1999',
  ])
    assert.equal(isDirectLookup(lookup), true);
  assert.equal(isDirectLookup('a film set in 1999'), false);
});

it('recognizes a typo in the main title when the catalog title has a subtitle', () => {
  const result = movie(13885, 'Sweeney Todd: The Demon Barber of Fleet Street');
  const ranked = rankTitleResults('sweeny todd', [result], [], filters);
  assert.equal(ranked.confident, true);
  assert.deepEqual(ranked.credible, [result]);
});
