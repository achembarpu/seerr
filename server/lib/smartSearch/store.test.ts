import { execFile } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
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

type VersionTestInternals = {
  all: (
    sql: string,
    params?: (string | number)[],
    db?: unknown
  ) => Promise<unknown[]>;
  run: (
    sql: string,
    params?: (string | number | Buffer | null)[],
    db?: unknown
  ) => Promise<void>;
  lexicalTask?: Promise<void>;
};

const versionTestStore = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-version-'));
  const filename = path.join(directory, 'store.sqlite3');
  const store = new SmartStore(filename);
  await store.initialize();
  store.pauseLexical();
  await (store as unknown as VersionTestInternals).lexicalTask;
  return { directory, filename, store };
};

it('tracks local and external document changes without invalidating on local lexical work', async () => {
  const { directory, filename, store } = await versionTestStore();
  let other: SmartStore | undefined;
  try {
    const initial = await store.documentVersion();
    assert.ok(initial);
    await store.setState('lexicalCursor', '1');
    const internal = store as unknown as VersionTestInternals;
    await internal.run(
      'INSERT INTO smart_fts(rowid, title, overview) VALUES (?, ?, ?)',
      [90, 'A', 'B']
    );
    assert.equal(await store.documentVersion(), initial);
    await store.upsertBatch([]);
    assert.equal(await store.documentVersion(), initial);
    await store.upsert(doc('1'), quantize([1, 0]));
    const inserted = await store.documentVersion();
    assert.notEqual(inserted, initial);
    await store.remove('tmdb', 'movie', '1');
    const deleted = await store.documentVersion();
    assert.notEqual(deleted, inserted);
    other = new SmartStore(filename);
    await other.upsert(doc('2'), quantize([1, 0]));
    const externalInsert = await store.documentVersion();
    assert.notEqual(externalInsert, deleted);
    await other.remove('tmdb', 'movie', '2');
    assert.notEqual(await store.documentVersion(), externalInsert);
  } finally {
    await other?.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('withholds document versions throughout overlapping local writes, including failures', async () => {
  const { directory, store } = await versionTestStore();
  try {
    const before = await store.documentVersion();
    const internal = store as unknown as VersionTestInternals;
    const run = internal.run.bind(store);
    const releases: (() => void)[] = [];
    internal.run = async (...args) => {
      if (
        args[0].startsWith('INSERT INTO smart_documents') ||
        args[0].startsWith('DELETE FROM smart_documents')
      )
        await new Promise<void>((resolve) => releases.push(resolve));
      return run(...args);
    };
    const first = store.upsert(doc('1'), quantize([1, 0]));
    const second = store.remove('tmdb', 'movie', '2');
    assert.equal(releases.length, 2);
    assert.equal(await store.documentVersion(), undefined);
    releases[0]();
    await first;
    assert.equal(await store.documentVersion(), undefined);
    releases[1]();
    await second;
    const after = await store.documentVersion();
    assert.notEqual(after, before);
    internal.run = run;
    await assert.rejects(
      store.upsert(
        doc('3', { source: null as unknown as string }),
        quantize([1, 0])
      ),
      /SQLITE_CONSTRAINT/
    );
    assert.notEqual(await store.documentVersion(), after);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects unsafe versions on a racing write, DB error, close, or reopen', async () => {
  const { directory, filename, store } = await versionTestStore();
  let reopened: SmartStore | undefined;
  let closed = false;
  try {
    const initial = await store.documentVersion();
    const internal = store as unknown as VersionTestInternals;
    const all = internal.all.bind(store);
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    internal.all = async (...args) => {
      const rows = await all(...args);
      if (args[0] === 'PRAGMA data_version') {
        entered();
        await gate;
      }
      return rows;
    };
    const racing = store.documentVersion();
    await started;
    await store.upsert(doc('1'), quantize([1, 0]));
    release();
    assert.equal(await racing, undefined);
    internal.all = async (...args) => {
      if (args[0] === 'PRAGMA data_version')
        throw new Error('Injected version read error');
      return all(...args);
    };
    await assert.rejects(
      store.documentVersion(),
      /Injected version read error/
    );
    internal.all = all;
    await store.close();
    closed = true;
    await assert.rejects(store.documentVersion(), /closing/);
    reopened = new SmartStore(filename);
    assert.notEqual(await reopened.documentVersion(), initial);
  } finally {
    if (!closed) await store.close();
    await reopened?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps scored vectors and documents consistent while the index changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-snapshot-'));
  const store = new SmartStore(path.join(directory, 'store.sqlite3'));
  try {
    await store.initialize();
    await store.upsert(
      doc('100', { title: 'Before update' }),
      quantize([1, 0])
    );
    await store.upsert(
      doc('101', { title: 'Before deletion' }),
      quantize([0.9, 0.1])
    );
    const internal = store as unknown as {
      all: (
        sql: string,
        params?: (string | number)[],
        db?: unknown
      ) => Promise<unknown[]>;
    };
    const original = internal.all.bind(store);
    let changed = false;
    internal.all = async (...args) => {
      const rows = await original(...args);
      if (!changed && args[0].startsWith('SELECT id, vector, voteCount')) {
        changed = true;
        await store.upsert(
          doc('100', { title: 'After update' }),
          quantize([-1, 0])
        );
        await store.remove('tmdb', 'movie', '101');
      }
      return rows;
    };
    const results = await store.search(quantize([1, 0]));
    assert.deepEqual(
      results.map((item) => item.document.title),
      ['Before update', 'Before deletion']
    );
    assert.equal(
      (await store.find('tmdb', 'movie', '100'))?.document.title,
      'After update'
    );
    assert.equal(await store.find('tmdb', 'movie', '101'), undefined);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('updates exact reusable neighbor pools from changed rows and rebuilds when history expires', async () => {
  const { directory, filename, store } = await versionTestStore();
  const other = new SmartStore(filename);
  try {
    const internal = store as unknown as VersionTestInternals;
    const scanPlans: ('full' | 'subset')[] = [];
    const all = internal.all.bind(store);
    internal.all = async (...args) => {
      if (args[0].startsWith('SELECT id, vector, voteCount')) {
        scanPlans.push(args[0].includes('id IN') ? 'subset' : 'full');
      }
      return all(...args);
    };
    await store.upsertBatch(
      Array.from({ length: 64 }, (_, i) => ({
        document: doc(String(i + 1)),
        vector: quantize([1, (i + 1) / 64]),
      }))
    );
    const vectors = [quantize([1, 0]), quantize([-1, 0])];
    const filters = { language: 'en', genre: 12 };
    const limit = 3;
    const cached = () => store.searchNeighbors(vectors, filters, limit);
    const fresh = () => store.searchMany(vectors, filters, limit);

    assert.deepEqual(await cached(), await fresh());
    scanPlans.length = 0;
    await cached();
    assert.equal(scanPlans.length, 0);

    await other.upsert(doc('70'), quantize([1, 0]));
    const afterInsert = await cached();
    assert.equal(afterInsert[0][0].document.sourceId, '70');
    assert.ok(scanPlans.includes('subset'));
    assert.ok(!scanPlans.includes('full'));
    assert.deepEqual(afterInsert, await fresh());

    scanPlans.length = 0;
    await other.upsert(doc('70', { title: 'Changed' }), quantize([1, 0]));
    await other.remove('tmdb', 'movie', '1');
    const afterUpdate = await cached();
    assert.equal(afterUpdate[0][0].document.title, 'Changed');
    assert.ok(!scanPlans.includes('full'));
    assert.deepEqual(afterUpdate, await fresh());

    await store.upsert(doc('71'), quantize([-1, 0]));
    await store.remove('tmdb', 'movie', '70');
    await internal.run(
      'DELETE FROM smart_neighbor_changes WHERE seq < (SELECT MAX(seq) FROM smart_neighbor_changes)'
    );
    scanPlans.length = 0;
    const refreshed = await cached();
    assert.ok(scanPlans.includes('full'));
    assert.deepEqual(refreshed, await fresh());
  } finally {
    await other.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('searches a transient in-memory index without a second connection', async () => {
  const store = new SmartStore(':memory:');
  try {
    await store.initialize();
    await store.upsert(doc('100'), quantize([1, 0]));
    assert.equal(
      (await store.search(quantize([1, 0])))[0].document.sourceId,
      '100'
    );
  } finally {
    await store.close();
  }
});

it('keeps stable ties and all results when the shortlist needs multiple fetches', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-ties-'));
  const store = new SmartStore(path.join(directory, 'store.sqlite3'));
  try {
    await store.initialize();
    for (let start = 0; start < 610; start += 100) {
      await store.upsertBatch(
        Array.from({ length: Math.min(100, 610 - start) }, (_, offset) => ({
          document: doc(String(start + offset), { voteCount: 0 }),
          vector: quantize([1, 0]),
        }))
      );
    }
    const matches = await store.search(quantize([1, 0]), {}, 605);
    assert.equal(matches.length, 605);
    assert.deepEqual(
      matches.map(({ document }) => document.sourceId),
      Array.from({ length: 605 }, (_, index) => String(index))
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('waits for an active search snapshot to close before shutting down', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-close-'));
  const store = new SmartStore(path.join(directory, 'store.sqlite3'));
  try {
    await store.initialize();
    await store.upsert(doc('100'), quantize([1, 0]));
    const internal = store as unknown as {
      all: (
        sql: string,
        params?: (string | number)[],
        db?: unknown
      ) => Promise<unknown[]>;
    };
    const original = internal.all.bind(store);
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    internal.all = async (...args) => {
      if (args[0].startsWith('SELECT id, vector, voteCount')) {
        signalStarted();
        await gate;
      }
      return original(...args);
    };
    const search = store.search(quantize([1, 0]));
    await started;
    let closed = false;
    const shutdown = store.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    release();
    assert.equal((await search)[0].document.sourceId, '100');
    await shutdown;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('releases its read transaction when loading a shortlisted document fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-error-'));
  const store = new SmartStore(path.join(directory, 'store.sqlite3'));
  try {
    await store.initialize();
    await store.upsert(doc('100'), quantize([1, 0]));
    const internal = store as unknown as {
      all: (
        sql: string,
        params?: (string | number)[],
        db?: unknown
      ) => Promise<unknown[]>;
      lexicalTask?: Promise<void>;
    };
    store.pauseLexical();
    await internal.lexicalTask;
    const original = internal.all.bind(store);
    internal.all = async (...args) => {
      if (
        args[0].startsWith(
          'SELECT id, document FROM smart_documents WHERE id IN'
        )
      )
        throw new Error('Injected shortlist read error');
      return original(...args);
    };
    await assert.rejects(
      store.search(quantize([1, 0])),
      /Injected shortlist read error/
    );
    await store.upsert(
      doc('100', { title: 'Updated after failure' }),
      quantize([1, 0])
    );
    const checkpoint = (await original('PRAGMA wal_checkpoint(TRUNCATE)')) as {
      busy: number;
    }[];
    assert.equal(checkpoint[0].busy, 0);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('reports an inaccessible snapshot without an unhandled SQLite error', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-open-error-'));
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs/promises');
    const { SmartStore } = require('./server/lib/smartSearch/store');
    (async () => {
      const file = process.argv[1];
      const store = new SmartStore(file);
      await store.initialize();
      store.pauseLexical();
      await store.lexicalTask;
      await fs.rename(file, file + '.moved');
      await assert.rejects(store.search(Buffer.from([1])), /SQLITE_CANTOPEN/);
      await store.close();
      console.log('handled');
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  try {
    const result = await promisify(execFile)(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        '-r',
        'tsconfig-paths/register',
        '-e',
        script,
        path.join(directory, 'store.sqlite3'),
      ],
      { cwd: process.cwd(), timeout: 15000 }
    );
    assert.match(result.stdout, /handled/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

it('uses covering metadata for selective lexical search with the same filter and tie order', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-fts-cover-'));
  const filename = path.join(directory, 'store.sqlite3');
  const portable = new SmartStore(filename, '');
  const covered = new SmartStore(filename, 'unused-for-lexical-ranking');
  const vector = quantize([1, 0]);
  const series = (id: string, overrides: Partial<SmartDocument> = {}) =>
    doc(id, {
      mediaType: 'tv',
      title: 'A risky heist',
      overview: 'A thief races through the city.',
      ...overrides,
    });
  const filters = {
    mediaType: 'tv' as const,
    language: 'en',
    yearFrom: 2010,
    yearTo: 2025,
    minRating: 7,
    minVotes: 100,
    genre: 12,
  };
  try {
    await portable.initialize();
    await portable.upsertBatch(
      [
        series('99'),
        series('1'),
        series('2', { genreIds: [35] }),
        series('3', { voteCount: 99 }),
        series('4', { mediaType: 'movie' }),
        series('5', { originalLanguage: 'ko' }),
        series('6', { year: 2026 }),
        series('7', { voteAverage: 6 }),
        series('8'),
      ].map((document) => ({ document, vector }))
    );
    await covered.initialize();
    const baseline = await portable.searchLexical('heist city', filters, 2);
    const optimized = await covered.searchLexical('heist city', filters, 2);
    assert.deepEqual(optimized, baseline);
    assert.deepEqual(
      optimized.map(({ document }) => document.sourceId),
      ['99', '1']
    );
    assert.equal(optimized[0].score, optimized[1].score);
  } finally {
    await Promise.all([portable.close(), covered.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

it('retrieves compound keywords, prioritizes multiple matching terms and honors filters', async () => {
  const { directory, store } = await versionTestStore();
  const vector = quantize([1, 0]);
  try {
    await store.upsertBatch(
      [
        doc('1', { keywords: ['barbershop', 'murder'], voteCount: 150 }),
        doc('2', { keywords: ['murder'], voteCount: 9500 }),
        doc('3', { keywords: ['murder'], voteCount: 20 }),
        doc('4', { keywords: ['barber', 'murder'], originalLanguage: 'ko' }),
        doc('5', { keywords: ['barber', 'murder'], mediaType: 'tv' }),
        doc('6', { keywords: ['barber', 'murder'], year: 1980 }),
        doc('7', { keywords: ['barber', 'murder'], genreIds: [35] }),
        doc('8', { keywords: ['barber', 'murder'], voteAverage: 5 }),
        doc('9', { keywords: ['lucid dreaming', 'a risky heist'] }),
        doc('10', { keywords: ['barber', 'murder'], voteCount: 25 }),
        doc('11', { keywords: ['barber', 'murder'], year: 2030 }),
      ].map((document) => ({ document, vector }))
    );
    const matches = await store.searchKeywords('barber murders', {
      mediaType: 'movie',
      language: 'en',
      yearFrom: 2010,
      yearTo: 2025,
      minRating: 7,
      minVotes: 50,
      genre: 12,
    });
    assert.deepEqual(
      matches.map(({ document }) => document.sourceId),
      ['1', '2']
    );
    assert.ok(matches[0].score > matches[1].score);
    assert.deepEqual(matches[0].methods, ['tmdb-keyword']);
    assert.deepEqual(
      (await store.searchKeywords('murder', { minVotes: 500 }, 1)).map(
        ({ document }) => document.sourceId
      ),
      ['2']
    );
    assert.equal(
      (await store.searchKeywords('film about a dream heist'))[0].document
        .sourceId,
      '9'
    );
    assert.deepEqual(await store.searchKeywords('barb'), []);
    const stopped = AbortSignal.abort(new Error('Search cancelled'));
    await assert.rejects(
      store.searchKeywords('murder', {}, 10, stopped),
      /Search cancelled/
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('enriches high-vote titles without updating vectors, and maintains keyword coverage through refresh and deletion', async () => {
  const { directory, store } = await versionTestStore();
  const vector = quantize([1, 0]);
  const pending = async () =>
    (await store.nextKeywordEnrichment('tmdb', 16)).map(
      ({ sourceId }) => sourceId
    );
  try {
    await store.upsertBatch(
      [
        doc('1', { voteCount: 200 }),
        doc('2', { voteCount: 3000 }),
        doc('3', { voteCount: 99 }),
        doc('4', { voteCount: 4000, keywords: [] }),
        doc('5', { voteCount: 7000, source: 'other' }),
      ].map((document) => ({ document, vector }))
    );
    assert.deepEqual(await pending(), ['2', '1']);
    assert.equal((await store.nextKeywordEnrichment('tmdb', 1)).length, 1);
    const before = await store.documentVersion();
    await store.setKeywords('tmdb', 'movie', '2', ['barber', 'murder']);
    await store.setKeywords('tmdb', 'movie', '1', []);
    assert.equal(await store.documentVersion(), before);
    assert.deepEqual((await store.find('tmdb', 'movie', '2'))?.vector, vector);
    assert.deepEqual(await pending(), []);
    assert.equal(
      (await store.searchKeywords('barber'))[0]?.document.sourceId,
      '2'
    );

    await store.upsert(
      doc('2', { voteCount: 3200, title: 'New card' }),
      vector
    );
    assert.equal(
      (await store.searchKeywords('barber'))[0]?.document.title,
      'New card'
    );
    assert.deepEqual(await pending(), []);
    const explicit = doc('2', { voteCount: 3200, keywords: ['dream'] });
    await store.upsert(explicit, vector);
    assert.deepEqual(await store.searchKeywords('barber'), []);
    assert.equal(
      (await store.searchKeywords('dream'))[0]?.document.sourceId,
      '2'
    );
    await store.setKeywords('tmdb', 'movie', '2', []);
    await store.upsert(explicit, vector);
    assert.equal(
      (await store.searchKeywords('dream'))[0]?.document.sourceId,
      '2'
    );

    await store.remove('tmdb', 'movie', '2');
    assert.deepEqual(await store.searchKeywords('dream'), []);
    await store.upsert(doc('2', { voteCount: 3200 }), vector);
    assert.deepEqual(await pending(), ['2']);
    assert.deepEqual(await store.searchKeywords('dream'), []);
    await store.upsert(doc('2', { voteCount: 3200, keywords: [] }), vector);
    assert.deepEqual(await pending(), []);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('interrupts an aborted lexical read on its own connection', async () => {
  const { directory, store } = await versionTestStore();
  const internal = store as unknown as VersionTestInternals & {
    db: unknown;
  };
  const original = internal.all.bind(store);
  let started: () => void = () => undefined;
  let release: () => void = () => undefined;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reader: { interrupt: () => void } | undefined;
  let interrupts = 0;
  internal.all = async (...args) => {
    if (args[0].includes('smart_fts.rank AS rank')) {
      reader = args[2] as typeof reader;
      if (reader && reader !== internal.db) {
        const interrupt = reader.interrupt.bind(reader);
        reader.interrupt = () => {
          interrupts++;
          interrupt();
        };
      }
      started();
      await held;
    }
    return original(...args);
  };
  try {
    await store.upsert(doc('30'), quantize([1, 0]));
    const controller = new AbortController();
    const reason = new Error('New search started');
    const search = store.searchLexical('family', {}, 5, controller.signal);
    await running;
    controller.abort(reason);
    release();
    await assert.rejects(search, (error) => error === reason);
    assert.ok(reader);
    assert.notEqual(reader, internal.db);
    assert.equal(interrupts, 1);
    assert.ok(await store.documentVersion());
  } finally {
    release();
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

it('returns the same filtered rankings for separate and batched query vectors', async () => {
  const store = new SmartStore(':memory:');
  try {
    await store.initialize();
    const vectors = [
      [1, 0],
      [0, 1],
      [1, 1],
    ].map(quantize);
    for (let index = 0; index < 12; index++) {
      await store.upsert(
        doc(String(index), {
          originalLanguage: index % 2 ? 'en' : 'fr',
          voteCount: index * 139,
        }),
        vectors[index % vectors.length]
      );
    }
    const filters = { language: 'en' };
    const independent = await Promise.all(
      vectors.map((vector) => store.search(vector, filters, 3))
    );
    const batch = await store.searchMany(vectors, filters, 3);
    assert.deepEqual(batch, independent);
    await assert.rejects(
      store.searchMany(vectors, filters, 3, AbortSignal.abort()),
      { name: 'AbortError' }
    );
  } finally {
    await store.close();
  }
});

it(
  'uses native SQLite ranking with the same scores, filters and stable ties',
  { skip: !process.env.SEERR_TEST_VECTOR_EXTENSION },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-native-'));
    const filename = path.join(directory, 'store.sqlite3');
    const portable = new SmartStore(filename, '');
    const native = new SmartStore(
      filename,
      process.env.SEERR_TEST_VECTOR_EXTENSION
    );
    const unavailable = new SmartStore(
      filename,
      path.join(directory, 'missing.dylib')
    );
    try {
      await portable.initialize();
      const vectors = [
        [1, 0, -1],
        [0, 1, -1],
        [-1, 0, 1],
        [1, 0, 0],
      ].map(quantize);
      await portable.upsertBatch(
        Array.from({ length: 50 }, (_, index) => ({
          document: doc(String(index), {
            originalLanguage: index % 2 ? 'en' : 'fr',
            voteCount: (index % 7) * 123,
          }),
          vector: vectors[index % vectors.length],
        }))
      );
      const expected = await portable.searchMany(
        vectors,
        { language: 'en' },
        6
      );
      assert.deepEqual(
        await native.searchMany(vectors, { language: 'en' }, 6),
        expected
      );
      assert.equal(native.vectorBackend, 'sqlite');
      assert.deepEqual(
        await native.searchMany(vectors, { language: 'ko' }, 6),
        [[], [], [], []]
      );
      assert.deepEqual(
        await unavailable.searchMany(vectors, { language: 'en' }, 6),
        expected
      );
      assert.equal(unavailable.vectorBackend, 'javascript');
    } finally {
      await Promise.all([
        portable.close(),
        native.close(),
        unavailable.close(),
      ]);
      await rm(directory, { recursive: true, force: true });
    }
  }
);
