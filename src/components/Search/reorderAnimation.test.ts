import assert from 'node:assert/strict';
import { it } from 'node:test';
import { shouldAnimateReorder, type ReorderSnapshot } from './reorderAnimation';

const suggestions = { results: [] };
const smartResults = { results: [] };
const snapshot: ReorderSnapshot = {
  context: 'barber',
  order: 'movie:1|tv:1',
  regularResults: 'movie:1|tv:1',
  suggestions,
  smartResults,
  gridWidth: 900,
  viewportWidth: 1200,
  viewportHeight: 800,
};

it('animates an asynchronous reorder within the same search', () => {
  assert.equal(
    shouldAnimateReorder(
      snapshot,
      { ...snapshot, order: 'tv:1|movie:1', smartResults: {} },
      false,
      false,
      false
    ),
    true
  );
});

it('does not animate query, filter, pagination, resize or incidental reorders', () => {
  const next = { ...snapshot, order: 'tv:1|movie:1', smartResults: {} };
  assert.equal(
    shouldAnimateReorder(undefined, next, false, false, false),
    false
  );
  assert.equal(
    shouldAnimateReorder(
      snapshot,
      { ...next, context: 'new search' },
      false,
      false,
      false
    ),
    false
  );
  assert.equal(
    shouldAnimateReorder(
      snapshot,
      { ...next, regularResults: 'movie:1|tv:1|movie:2' },
      false,
      false,
      false
    ),
    false
  );
  assert.equal(
    shouldAnimateReorder(
      snapshot,
      { ...next, gridWidth: 700 },
      false,
      false,
      false
    ),
    false
  );
  assert.equal(
    shouldAnimateReorder(
      snapshot,
      { ...next, viewportHeight: 700 },
      false,
      false,
      false
    ),
    false
  );
  assert.equal(
    shouldAnimateReorder(
      snapshot,
      { ...next, viewportWidth: 800 },
      false,
      false,
      false
    ),
    false
  );
  assert.equal(
    shouldAnimateReorder(
      snapshot,
      { ...next, smartResults },
      false,
      false,
      false
    ),
    false
  );
  assert.equal(
    shouldAnimateReorder(
      snapshot,
      { ...next, order: snapshot.order },
      false,
      false,
      false
    ),
    false
  );
});

it('respects reduced motion and avoids movement while scrolling or paginating', () => {
  const next = { ...snapshot, order: 'tv:1|movie:1', suggestions: {} };
  assert.equal(shouldAnimateReorder(snapshot, next, true, false, false), false);
  assert.equal(shouldAnimateReorder(snapshot, next, false, true, false), false);
  assert.equal(shouldAnimateReorder(snapshot, next, false, false, true), false);
});
