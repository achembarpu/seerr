import assert from 'node:assert/strict';
import { it } from 'node:test';
import { explainMatch, explanationTerms } from './explanation';
import type { SmartMatch } from './store';

const match: SmartMatch = {
  score: 0.02,
  methods: ['semantic', 'tmdb-recommendation'],
  seedTitle: 'Seed Film',
  sharedGenreIds: [18],
  document: {
    source: 'tmdb',
    sourceId: '1',
    mediaType: 'movie',
    title: 'Example',
    overview: 'A barber looks for work.',
    originalLanguage: 'en',
    year: null,
    genreIds: [18],
    voteAverage: 0,
    voteCount: 0,
    popularity: 0,
    card: {},
  },
};

it('uses actual overview words, source and contributing seed as evidence', () => {
  const result = explainMatch(
    match,
    explanationTerms('film about a barber who takes revenge'),
    'requests'
  );
  assert.deepEqual(result.terms, ['barber']);
  assert.equal(result.description, true);
  assert.equal(result.tmdb, 'related');
  assert.equal(result.seedTitle, 'Seed Film');
  assert.deepEqual(result.sharedGenreIds, [18]);
  assert.equal(result.basis, 'requests');
});

it('does not invent a word match for a cross-language result', () => {
  const result = explainMatch(match, explanationTerms('復讐する理髪師'));
  assert.equal(result.terms, undefined);
  assert.equal(result.description, true);
});
