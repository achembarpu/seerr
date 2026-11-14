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

it('indexes lexical metadata without changing embeddings, and keeps it updated', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-lexical-'));
  const store = new SmartStore(path.join(directory, 'store.sqlite3'));
  try {
    await store.initialize();
    const vector = quantize([1, 0]);
    await store.upsert(
      doc('22', {
        title: 'The Barber',
        overview: 'A barber pursues a murderer',
      }),
      vector
    );
    assert.equal(
      (await store.searchLexical('barber murder'))[0]?.document.sourceId,
      '22'
    );
    assert.deepEqual((await store.find('tmdb', 'movie', '22'))?.vector, vector);
    await store.upsert(
      doc('22', { title: 'New Title', overview: 'A voyage to the stars' }),
      vector
    );
    assert.equal((await store.searchLexical('barber')).length, 0);
    assert.equal(
      (await store.searchLexical('voyage'))[0]?.document.sourceId,
      '22'
    );
    await store.remove('tmdb', 'movie', '22');
    assert.equal((await store.searchLexical('voyage')).length, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('pauses lexical backfill at its checkpoint and resumes without changing vectors', async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'smart-lexical-pause-')
  );
  const store = new SmartStore(path.join(directory, 'store.sqlite3'));
  const methods = store as unknown as {
    lexicalTask?: Promise<void>;
    run: (sql: string, params?: (string | number | null)[]) => Promise<void>;
  };
  try {
    await store.initialize();
    store.pauseLexical();
    await methods.lexicalTask;
    const vector = quantize([1, 0]);
    await store.upsertBatch(
      Array.from({ length: 600 }, (_, index) => ({
        document: doc(String(index), { overview: `unique story ${index}` }),
        vector,
      }))
    );
    await methods.run('DELETE FROM smart_fts');
    await store.setState('lexicalCursor', '0');
    const setState = store.setState.bind(store);
    store.setState = async (key, value) => {
      await setState(key, value);
      if (key === 'lexicalCursor' && Number(value) > 0) store.pauseLexical();
    };
    store.resumeLexical();
    await methods.lexicalTask;
    const cursor = Number(await store.getState('lexicalCursor'));
    assert.ok(cursor > 0 && cursor < 600);
    assert.equal(store.lexicalStatus().complete, false);
    store.setState = setState;
    store.resumeLexical();
    await methods.lexicalTask;
    assert.equal(store.lexicalStatus().complete, true);
    assert.equal(store.lexicalStatus().indexed, 600);
    assert.deepEqual(
      (await store.find('tmdb', 'movie', '599'))?.vector,
      vector
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('resumes if lexical indexing is re-enabled while a paused batch is finalizing', async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'smart-lexical-race-')
  );
  const store = new SmartStore(path.join(directory, 'store.sqlite3'));
  const methods = store as unknown as {
    lexicalTask?: Promise<void>;
    run: (sql: string, params?: (string | number | null)[]) => Promise<void>;
  };
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finalizing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    await store.initialize();
    store.pauseLexical();
    await methods.lexicalTask;
    const vector = quantize([1, 0]);
    await store.upsertBatch(
      Array.from({ length: 600 }, (_, index) => ({
        document: doc(String(index)),
        vector,
      }))
    );
    await methods.run('DELETE FROM smart_fts');
    await store.setState('lexicalCursor', '0');
    const setState = store.setState.bind(store);
    const count = store.count.bind(store);
    let paused = false;
    let blocked = false;
    store.setState = async (key, value) => {
      await setState(key, value);
      if (!paused && key === 'lexicalCursor' && Number(value) > 0) {
        paused = true;
        store.pauseLexical();
      }
    };
    store.count = async () => {
      const result = await count();
      if (paused && !blocked) {
        blocked = true;
        entered();
        await gate;
      }
      return result;
    };
    store.resumeLexical();
    const first = methods.lexicalTask;
    await finalizing;
    store.resumeLexical();
    release();
    await first;
    for (let i = 0; i < 100 && !store.lexicalStatus().complete; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(store.lexicalStatus().complete, true);
    assert.equal(store.lexicalStatus().indexed, 600);
    assert.equal(Number(await store.getState('lexicalCursor')), 600);
    assert.deepEqual(
      (await store.find('tmdb', 'movie', '599'))?.vector,
      vector
    );
  } finally {
    release();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
