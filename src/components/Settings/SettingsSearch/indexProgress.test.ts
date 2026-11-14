import assert from 'node:assert/strict';
import { it } from 'node:test';
import { indexProgress } from './indexProgress';

it('shows both saved cursors as paused when indexing is idle', () => {
  const result = indexProgress({
    indexing: false,
    popularCursor: { type: 'movie', page: 7, totalPages: 25 },
    cursor: { mediaType: 'tv', year: 2023, month: 6, day: 9, page: 3 },
  });
  assert.deepEqual(result.popular, {
    type: 'movie',
    page: 7,
    totalPages: 25,
    paused: true,
  });
  assert.deepEqual(result.chronological, {
    mediaType: 'tv',
    period: '2023-06-09',
    page: 3,
    paused: true,
  });
});

it('shows the active popular pass instead of the saved chronological cursor', () => {
  const result = indexProgress({
    indexing: true,
    popularCursor: { type: 'tv', page: 2, totalPages: 25 },
    cursor: { mediaType: 'movie', year: 2021, month: 0, page: 1 },
  });
  assert.equal(result.popular?.paused, false);
  assert.equal(result.chronological, undefined);
});

it('shows a running chronological scan when no popular pass is active', () => {
  const result = indexProgress({
    indexing: true,
    cursor: { mediaType: 'movie', year: 2021, month: 0, page: 5 },
  });
  assert.deepEqual(result.chronological, {
    mediaType: 'movie',
    period: '2021',
    page: 5,
    paused: false,
  });
});
