import { mkdtemp, rm } from 'fs/promises';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import os from 'os';
import path from 'path';
import { SmartStore, documentHash } from './store';
import type { SmartDocument } from './types';
import { quantize } from './vectors';

const doc = (
  id: string,
  overrides: Partial<SmartDocument> = {}
): SmartDocument => ({
  source: 'tmdb',
  sourceId: id,
  mediaType: 'movie',
  title: `Film ${id}`,
  overview: 'A family adventure',
  originalLanguage: 'en',
  year: 2020,
  genreIds: [12, 10751],
  voteAverage: 8,
  voteCount: 100,
  popularity: 2,
  card: { id: Number(id) },
  ...overrides,
});

describe('smart search index', () => {
  let store: SmartStore;
  let directory: string;
  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'seerr-smart-'));
    store = new SmartStore(path.join(directory, 'index.sqlite'));
    await store.initialize();
  });
  after(async () => {
    await store.close();
    await rm(directory, { recursive: true });
  });
  it('stores, ranks and filters media without mixing providers', async () => {
    await store.upsert(doc('1'), quantize([1, 0]));
    await store.upsert(
      doc('2', {
        mediaType: 'tv',
        originalLanguage: 'ja',
        year: 2010,
        voteAverage: 6,
        genreIds: [35],
      }),
      quantize([0.9, 0.1])
    );
    await store.upsert(
      doc('1', { source: 'other', voteCount: 2 }),
      quantize([0.5, 0.5])
    );
    assert.equal(await store.count(), 3);
    assert.deepEqual(
      (
        await store.search(quantize([1, 0]), {
          mediaType: 'movie',
          yearFrom: 2019,
          minRating: 7,
          minVotes: 10,
          genre: 12,
        })
      ).map((item) => item.document.sourceId),
      ['1']
    );
    assert.deepEqual(
      (await store.search(quantize([1, 0]), { language: 'ja' })).map(
        (item) => item.document.sourceId
      ),
      ['2']
    );
    assert.equal(
      (await store.find('other', 'movie', '1'))?.document.source,
      'other'
    );
  });
  it('uses audience evidence only to break close semantic ties', async () => {
    await store.upsert(
      doc('10', { originalLanguage: 'de', voteCount: 0 }),
      quantize([1, 0])
    );
    await store.upsert(
      doc('11', { originalLanguage: 'de', voteCount: 1000 }),
      quantize([1, 0.1])
    );
    await store.upsert(
      doc('12', { originalLanguage: 'de', voteCount: 1000 }),
      quantize([0.8, 0.6])
    );
    const matches = await store.search(quantize([1, 0]), { language: 'de' });
    assert.deepEqual(
      matches.map((match) => match.document.sourceId),
      ['11', '10', '12']
    );
    assert.ok(matches[0].score < matches[1].score);
  });

  it('does not re-embed for changes to ratings or cards', async () => {
    const original = doc('1');
    const update = doc('1', { voteAverage: 9, card: { id: 1, updated: true } });
    assert.equal(documentHash(original), documentHash(update));
    assert.notEqual(
      documentHash(original),
      documentHash(doc('1', { overview: 'A crime mystery' }))
    );
    await store.upsertBatch([{ document: update, vector: quantize([1, 0]) }]);
    assert.equal(
      (await store.find('tmdb', 'movie', '1'))?.document.voteAverage,
      9
    );
    await store.setState('cursor', 'checkpoint');
    assert.equal(await store.getState('cursor'), 'checkpoint');
  });
});
