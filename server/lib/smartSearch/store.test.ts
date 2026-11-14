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
