import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { SearchFilters } from './SmartSearch';
import {
  isDirectLookup,
  matchesFilters,
  mergeSearchResults,
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
  assert.equal(result[0].item, localized);
  assert.equal(result[0].pin, true);
  assert.equal(result.length, 3);
});

it('applies the same filters to title and description hits and deduplicates both', () => {
  const applied = { ...filters, language: 'en', rating: '7' };
  assert.equal(matchesFilters(person, applied), false);
  const title = movie(1, 'Maaveeran');
  const titles = rankTitleResults('maveran', [title, person], [], applied);
  assert.deepEqual(
    titles.map(({ item }) => item),
    [title]
  );
  const other = movie(2, 'Another story');
  assert.deepEqual(
    mergeSearchResults(
      titles,
      [
        title,
        other,
        other,
        movie(3, 'French title', { originalLanguage: 'fr' }),
      ],
      applied
    ).map(({ id }) => id),
    [1, 2]
  );
  assert.equal(matchesFilters(title, { ...filters, yearFrom: '2021' }), false);
});

it('ranks a semantic-only hit and agreement ahead of noisy title guesses', () => {
  const strongPlot = movie(13885, 'Sweeney Todd');
  const shared = movie(2, 'Barber', { matchScore: 0.79 });
  const titles = rankTitleResults(
    'barber murderers',
    [person],
    [movie(1, 'Bizarre Murders', { matchScore: 0.86 }), shared],
    filters
  );
  assert.equal(
    titles.some(({ pin }) => pin),
    false
  );
  const merged = mergeSearchResults(titles, [strongPlot, shared], filters);
  assert.deepEqual(
    merged.slice(0, 2).map(({ id }) => id),
    [2, 13885]
  );
});

it('pins a typo hit, keeps matching card metadata, and keeps media types separate', () => {
  const localized = movie(1, 'Maaveeran', { posterPath: '/localized.jpg' });
  const explanation = { description: true, terms: ['hero'] };
  const semantic = movie(1, 'Maaveeran (indexed)', {
    matchExplanation: explanation,
    posterPath: '/indexed.jpg',
    overview: 'A hero hears a voice.',
  });
  const series: SearchItem = {
    id: 1,
    mediaType: 'tv',
    name: 'Some Series',
    originalName: 'Some Series',
    popularity: 1,
    voteCount: 100,
    voteAverage: 8,
    genreIds: [18],
    overview: '',
    originalLanguage: 'en',
    firstAirDate: '2020-01-01',
    originCountry: [],
  };
  const titles = rankTitleResults(
    'maveran',
    [localized],
    [movie(1, 'Maaveeran', { matchScore: 0.98 })],
    filters
  );
  const merged = mergeSearchResults(
    titles,
    [series, movie(2, 'Another Film'), semantic],
    filters
  );
  assert.deepEqual(
    merged.map(({ mediaType, id }) => `${mediaType}:${id}`),
    ['movie:1', 'tv:1', 'movie:2']
  );
  const first = merged[0];
  assert.equal(first.mediaType, 'movie');
  assert.equal(first.title, 'Maaveeran');
  assert.equal(first.posterPath, '/localized.jpg');
  assert.equal(first.overview, 'A hero hears a voice.');
  assert.deepEqual(first.matchExplanation, explanation);
});

it('does not pin a generic word inside a longer title ahead of plot evidence', () => {
  const longer = movie(1, 'The Mad Barber');
  const exact = movie(2, 'Barber');
  const matchingPlot = movie(3, 'Sweeney Todd');
  const titles = rankTitleResults('barber', [longer, exact], [], filters);
  assert.deepEqual(
    titles.map(({ pin }) => pin),
    [true, false]
  );
  assert.deepEqual(
    mergeSearchResults(titles, [matchingPlot], filters).map(({ id }) => id),
    [2, 3, 1]
  );
});

it('retains compact non-Latin matches and partial title matches', () => {
  const parasite = movie(496243, 'Parasite', {
    originalTitle: '기생충',
    matchScore: 0.778,
  });
  const ranked = rankTitleResults('기생총', [], [parasite], filters);
  assert.equal(ranked[0].item, parasite);
  assert.equal(ranked[0].pin, true);
  const matrix = movie(603, 'The Matrix');
  assert.equal(
    rankTitleResults('matr', [matrix], [], filters)[0].evidence,
    0.9
  );
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
  assert.equal(ranked[0].pin, true);
  assert.equal(ranked[0].item, result);
});
