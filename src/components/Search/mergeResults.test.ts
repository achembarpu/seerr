import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { SearchFilters } from './SmartSearch';
import { matchesFilters, mergeResults, type SearchItem } from './mergeResults';

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

it('ranks the title match first and merges source evidence without conflating types', () => {
  const result = mergeResults(
    'maveran',
    [person, movie(2, 'Another Film')],
    [movie(1, 'Maaveeran', { matchScore: 0.98 })],
    [movie(1, 'Maaveeran'), movie(3, 'Something Else')],
    filters
  );
  assert.equal(result[0].id, 1);
  assert.equal(result[0].mediaType, 'movie');
  assert.deepEqual(result[0].matchMethods, ['approximate', 'semantic']);
  assert.equal(result.filter((r) => r.id === 1).length, 2);
  assert.equal(result.at(-1)?.id, 3);
});

it('applies the same filters across sources and excludes people for media-only filters', () => {
  assert.equal(matchesFilters(person, { ...filters, rating: '7' }), false);
  const results = mergeResults(
    'film',
    [movie(1, 'Film')],
    [movie(2, 'Film II', { originalLanguage: 'fr' })],
    [movie(3, 'Film III', { voteAverage: 4 })],
    { ...filters, language: 'en', rating: '7' }
  );
  assert.deepEqual(
    results.map((item) => item.id),
    [1]
  );
  assert.equal(
    matchesFilters(movie(1, 'Film'), { ...filters, yearFrom: '2021' }),
    false
  );
});

it('limits weak description-only discoveries for a confident title search', () => {
  const discoveries = Array.from({ length: 12 }, (_, index) =>
    movie(index + 2, `Other ${index}`)
  );
  const results = mergeResults(
    'maaveeran',
    [movie(1, 'Maaveeran')],
    [],
    discoveries,
    filters
  );
  assert.equal(results.length, 6);
  const descriptive = mergeResults(
    'a story about a long journey',
    [],
    [],
    discoveries,
    filters
  );
  assert.equal(descriptive.length, 12);
});
