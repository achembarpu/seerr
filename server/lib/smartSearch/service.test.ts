import { getSettings } from '@server/lib/settings';
import { mkdtemp, rm } from 'fs/promises';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, it, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'os';
import path from 'path';
import {
  SmartSearchService,
  balanceRecommendationPools,
  ratingEvidence,
  relatedPrior,
  storyMatchPenalty,
} from './service';
import { SmartStore } from './store';
import type { MetadataSource, SmartDocument } from './types';
import { quantize } from './vectors';

const document: SmartDocument = {
  source: 'tmdb',
  sourceId: '12',
  mediaType: 'movie',
  title: 'Example',
  overview: 'A mystery',
  originalLanguage: 'fr',
  year: 2020,
  genreIds: [9648],
  voteAverage: 7,
  voteCount: 100,
  popularity: 1,
  card: { id: 12 },
};
const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for indexing');
};

it('gives different seeds visible recommendations without repeating shared matches', () => {
  const shared = {
    document: { ...document, sourceId: 'shared' },
    score: 0.029,
  };
  const pools = [
    [
      shared,
      ...Array.from({ length: 12 }, (_, i) => ({
        document: { ...document, sourceId: `movie-${i}` },
        score: 0.025 - i / 1000,
      })),
    ],
    [
      shared,
      {
        document: { ...document, sourceId: 'series', mediaType: 'tv' as const },
        score: 0.02,
      },
    ],
  ];
  const ranked = balanceRecommendationPools(pools).map(
    (item) => item.document.sourceId
  );
  assert.deepEqual(ranked.slice(0, 3), ['shared', 'series', 'movie-0']);
  assert.equal(ranked.length, new Set(ranked).size);
});

it('discounts a shared setting when known genres or plot evidence do not support the match', () => {
  const seed = { ...document, genreIds: [18, 27] };
  const description =
    'A barber keeps a terrible secret in the shop until a customer starts to uncover the truth.';
  const horror = { ...document, genreIds: [18, 27], overview: description };
  const drama = { ...horror, genreIds: [18] };
  const sparse = { ...horror, overview: 'A story about a barber.' };
  assert.equal(storyMatchPenalty(seed, horror), 0);
  assert.ok(storyMatchPenalty(seed, drama) > storyMatchPenalty(seed, horror));
  assert.ok(storyMatchPenalty(seed, sparse) > storyMatchPenalty(seed, horror));
  assert.equal(storyMatchPenalty(seed, { ...horror, genreIds: [] }), 0);
});

it('does not infer a different format when either title has no genres', () => {
  const unknown = { ...document, genreIds: [], voteCount: 0 };
  const liveAction = { ...document, genreIds: [18], voteCount: 0 };
  const documentary = { ...document, genreIds: [99], voteCount: 0 };
  assert.equal(
    relatedPrior(unknown, liveAction),
    relatedPrior(unknown, documentary)
  );
  assert.equal(relatedPrior(liveAction, unknown), 0);
  assert.ok(
    relatedPrior(liveAction, documentary) < relatedPrior(liveAction, unknown)
  );
});

it('treats missing ratings as neutral and shrinks ratings with few votes', () => {
  assert.equal(
    ratingEvidence({ ...document, voteAverage: 0, voteCount: 0 }),
    0
  );
  const veryFew = ratingEvidence({
    ...document,
    voteAverage: 10,
    voteCount: 1,
  });
  const established = ratingEvidence({
    ...document,
    voteAverage: 8,
    voteCount: 1000,
  });
  assert.ok(veryFew > 0 && veryFew < established);
  assert.ok(
    ratingEvidence({ ...document, voteAverage: 4, voteCount: 1000 }) < 0
  );
});

describe('smart search lifecycle', () => {
  it('restarts an in-progress index when the inference device changes', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'smart-reconfigure-')
    );
    let enabled = true;
    let starts = 0;
    let stops = 0;
    let pages = 0;
    const engine = {
      phase: 'idle' as 'idle' | 'ready',
      downloadBytes: 0,
      downloadTotal: 1,
      async start() {
        starts++;
        this.phase = 'ready';
      },
      stop() {
        stops++;
        this.phase = 'idle';
      },
      async embed() {
        return [];
      },
    };
    const source: MetadataSource = {
      id: 'tmdb',
      async fetchOne() {
        return document;
      },
      async fetchPage(_type, _from, _to, _page, signal) {
        assert.ok(signal);
        pages++;
        if (pages > 1) throw new Error('stop test');
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener('abort', () => resolve(), { once: true });
        });
        signal.throwIfAborted();
        return { documents: [], totalPages: 0 };
      },
    };
    const service = new SmartSearchService(
      () => enabled,
      engine,
      source,
      () => new SmartStore(path.join(directory, 'index.sqlite'))
    );
    try {
      service.start();
      await waitFor(() => pages === 1);
      service.reconfigure();
      await waitFor(() => pages > 1);
      assert.equal(starts, 2);
      assert.equal(stops, 1);
    } finally {
      enabled = false;
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('starts only when enabled and resumes after a failed page', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-service-'));
    const filename = path.join(directory, 'index.sqlite');
    let enabled = false,
      calls = 0,
      embeds = 0;
    const engine = {
      phase: 'idle' as 'idle' | 'ready',
      downloadBytes: 0,
      downloadTotal: 1,
      async start() {
        this.phase = 'ready';
      },
      stop() {
        this.phase = 'idle';
      },
      async embed(texts: string[]) {
        embeds += texts.length;
        return texts.map(() => [1, 0]);
      },
    };
    const source: MetadataSource = {
      id: 'tmdb',
      async fetchOne() {
        return document;
      },
      async fetchPage() {
        calls++;
        if (calls > 1) throw new Error('offline');
        return {
          documents: [
            document,
            { ...document, sourceId: '13', title: 'Another film' },
          ],
          totalPages: 1,
        };
      },
    };
    const service = new SmartSearchService(
      () => enabled,
      engine,
      source,
      () => new SmartStore(filename)
    );
    try {
      service.start();
      assert.equal(calls, 0);
      enabled = true;
      service.start();
      await waitFor(() => !!service.status().error);
      assert.equal(service.status().count, 2);
      assert.equal(embeds, 2);
      assert.equal(
        (await service.search('mystery', { language: 'fr' })).length,
        2
      );
      const recommendations = await service.recommendations(
        [{ type: 'movie', id: '12' }],
        {}
      );
      assert.deepEqual(
        recommendations.map((item) => item.document.sourceId),
        ['13']
      );
      enabled = false;
      service.start();
      await service.close();
      const store = new SmartStore(filename);
      await store.initialize();
      assert.equal(
        JSON.parse((await store.getState('cursor'))!).mediaType,
        'tv'
      );
      await store.close();
    } finally {
      enabled = false;
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('updates changed metadata without recomputing an unchanged description', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-update-'));
    const filename = path.join(directory, 'index.sqlite');
    const store = new SmartStore(filename);
    await store.initialize();
    await store.upsert(document, quantize([1, 0]));
    await store.setState('lastUpdated', new Date().toISOString().slice(0, 10));
    await store.close();
    let enabled = true,
      embeds = 0;
    const engine = {
      phase: 'idle' as 'idle' | 'ready',
      downloadBytes: 0,
      downloadTotal: 1,
      async start() {
        this.phase = 'ready';
      },
      stop() {
        this.phase = 'idle';
      },
      async embed(texts: string[]) {
        embeds += texts.length;
        return texts.map(() => [1, 0]);
      },
    };
    const source: MetadataSource = {
      id: 'tmdb',
      async fetchPage() {
        throw new Error('unexpected full scan');
      },
      async fetchOne() {
        return { ...document, voteAverage: 9 };
      },
      async fetchChanges(type) {
        return { ids: type === 'movie' ? ['12'] : [], totalPages: 1 };
      },
    };
    const service = new SmartSearchService(
      () => enabled,
      engine,
      source,
      () => new SmartStore(filename)
    );
    try {
      service.start();
      await waitFor(() => !service.status().indexing);
      assert.equal(service.status().error, undefined);
      assert.equal(embeds, 0);
      enabled = false;
      service.start();
      await service.close();
      const saved = new SmartStore(filename);
      await saved.initialize();
      assert.equal(
        (await saved.find('tmdb', 'movie', '12'))?.document.voteAverage,
        9
      );
      await saved.close();
    } finally {
      enabled = false;
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('does not restart an enabled index while closing', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-close-'));
    let pages = 0;
    let starts = 0;
    const engine = {
      phase: 'idle' as 'idle' | 'ready',
      downloadBytes: 0,
      downloadTotal: 1,
      async start() {
        starts++;
        this.phase = 'ready';
      },
      stop() {
        this.phase = 'idle';
      },
      async embed() {
        return [];
      },
    };
    const source: MetadataSource = {
      id: 'tmdb',
      async fetchOne() {
        return undefined;
      },
      async fetchPage(_type, _from, _to, _page, signal) {
        pages++;
        assert.ok(signal);
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true })
        );
        signal.throwIfAborted();
        return { documents: [], totalPages: 0 };
      },
    };
    const service = new SmartSearchService(
      () => true,
      engine,
      source,
      () => new SmartStore(path.join(directory, 'index.sqlite'))
    );
    try {
      service.start();
      await waitFor(() => pages === 1);
      await service.close();
      await delay(20);
      assert.equal(starts, 1);
      assert.equal(pages, 1);
      assert.equal(service.status().indexing, false);
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('aborts an in-flight source request when disabled', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-cancel-'));
    let enabled = true;
    let receivedSignal = false;
    let aborted = false;
    const engine = {
      phase: 'idle' as 'idle' | 'ready',
      downloadBytes: 0,
      downloadTotal: 1,
      async start() {
        this.phase = 'ready';
      },
      stop() {
        this.phase = 'idle';
      },
      async embed(texts: string[]) {
        return texts.map(() => [1, 0]);
      },
    };
    const source: MetadataSource = {
      id: 'tmdb',
      async fetchOne() {
        return undefined;
      },
      async fetchPage(_type, _from, _to, _page, signal) {
        receivedSignal = !!signal;
        return new Promise((_resolve, reject) =>
          signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('cancelled'));
            },
            { once: true }
          )
        );
      },
    };
    const service = new SmartSearchService(
      () => enabled,
      engine,
      source,
      () => new SmartStore(path.join(directory, 'index.sqlite'))
    );
    try {
      service.start();
      await waitFor(() => receivedSignal);
      enabled = false;
      service.start();
      await waitFor(() => aborted && !service.status().indexing);
      assert.equal(service.status().phase, 'idle');
    } finally {
      enabled = false;
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('hybrid retrieval resilience', () => {
  it('uses lexical and remote results when embedding startup fails', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-hybrid-'));
    const filename = path.join(directory, 'index.sqlite3');
    const store = new SmartStore(filename);
    await store.initialize();
    await store.upsert(
      {
        ...document,
        sourceId: '20',
        title: 'Barber drama',
        overview: 'A barber unravels a murder mystery',
        card: { id: 20 },
      },
      quantize([1, 0])
    );
    await store.close();
    const settings = getSettings().main;
    const original = settings.smartSearchRefreshInterval;
    settings.smartSearchRefreshInterval = 'manual';
    const source: MetadataSource = {
      id: 'tmdb',
      async fetchOne() {
        return undefined;
      },
      async fetchPage() {
        return { documents: [], totalPages: 0 };
      },
      async searchRelated() {
        return [{ ...document, sourceId: '21', card: { id: 21 } }];
      },
    };
    const engine = {
      phase: 'idle' as const,
      downloadBytes: 0,
      downloadTotal: 1,
      async start() {
        throw new Error('offline');
      },
      stop() {},
      async embed() {
        return [];
      },
    };
    const service = new SmartSearchService(
      () => true,
      engine,
      source,
      () => new SmartStore(filename)
    );
    try {
      service.start();
      await waitFor(() => service.status().count === 1);
      const results = await service.search('barber murder', {});
      assert.ok(
        results.some(
          (result) =>
            result.document.sourceId === '20' &&
            result.methods?.includes('lexical')
        )
      );
      assert.ok(results.some((result) => result.document.sourceId === '21'));
      assert.ok(service.status().retrievalWarning);
    } finally {
      await service.close();
      settings.smartSearchRefreshInterval = original;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serves TMDB related candidates with local smart search disabled', async () => {
    const source: MetadataSource = {
      id: 'tmdb',
      async fetchOne() {
        return undefined;
      },
      async fetchPage() {
        return { documents: [], totalPages: 0 };
      },
      async fetchRelated(_type, _id, language) {
        assert.equal(language, 'fr');
        return [{ ...document, sourceId: '21', card: { id: 21 } }];
      },
    };
    const service = new SmartSearchService(() => false, undefined, source);
    const results = await service.similar('movie', '12', {}, 'fr');
    assert.equal(results[0]?.document.sourceId, '21');
    await service.close();
  });
});

describe('bounded search work', () => {
  it('caches dense results only for the same vector, filters, limit and index version', async () => {
    const service = new SmartSearchService(() => true);
    let version = 'one';
    let searches = 0;
    const internal = service as unknown as {
      store: {
        documentVersion: () => Promise<string | undefined>;
        search: (
          vector: Buffer,
          filters: { minRating?: number },
          limit: number
        ) => Promise<{ document: SmartDocument; score: number }[]>;
      };
      searchDense: (
        vector: Buffer,
        filters: { minRating?: number },
        limit: number
      ) => Promise<{ document: SmartDocument; score: number }[]>;
    };
    internal.store = {
      async documentVersion() {
        return version;
      },
      async search(_vector, filters, limit) {
        searches++;
        return [
          {
            document: {
              ...document,
              card: { ...document.card },
              title: version,
              voteAverage: 9,
            },
            score: 0.8,
          },
          {
            document: {
              ...document,
              card: { ...document.card },
              sourceId: 'other',
              title: 'other',
              voteAverage: 4,
            },
            score: 0.7,
          },
        ]
          .filter(
            (item) =>
              !filters.minRating ||
              item.document.voteAverage >= filters.minRating
          )
          .slice(0, limit);
      },
    };
    const vector = Buffer.from([1, 2]);
    const first = await internal.searchDense(vector, {}, 2);
    first[0].document.title = 'mutated by caller';
    first[0].document.card.id = 'mutated by caller';
    const cached = await internal.searchDense(vector, {}, 2);
    assert.equal(cached[0].document.title, 'one');
    assert.equal(cached[0].document.card.id, 12);
    assert.equal(searches, 1);
    assert.equal(
      (await internal.searchDense(vector, { minRating: 8 }, 2)).length,
      1
    );
    assert.equal((await internal.searchDense(vector, {}, 1)).length, 1);
    assert.equal(searches, 3);
    version = 'two';
    assert.equal(
      (await internal.searchDense(vector, {}, 2))[0].document.title,
      'two'
    );
    assert.equal(searches, 4);
  });

  it('does not cache scans when the index changes during the scan or its version is unavailable', async () => {
    const service = new SmartSearchService(() => true);
    let version: string | undefined = 'one';
    let searches = 0;
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const internal = service as unknown as {
      store: {
        documentVersion: () => Promise<string | undefined>;
        search: () => Promise<{ document: SmartDocument; score: number }[]>;
      };
      searchDense: (
        vector: Buffer,
        filters: object,
        limit: number
      ) => Promise<{ document: SmartDocument; score: number }[]>;
    };
    internal.store = {
      async documentVersion() {
        return version;
      },
      async search() {
        searches++;
        if (searches === 1) {
          started();
          await gate;
        }
        return [
          {
            document: { ...document, title: version ?? 'unavailable' },
            score: 0.8,
          },
        ];
      },
    };
    const vector = Buffer.from([1, 2]);
    const inFlight = internal.searchDense(vector, {}, 1);
    await startedPromise;
    version = 'two';
    release();
    await inFlight;
    await internal.searchDense(vector, {}, 1);
    assert.equal(searches, 2);
    version = undefined;
    await internal.searchDense(vector, {}, 1);
    await internal.searchDense(vector, {}, 1);
    assert.equal(searches, 4);
  });

  it('reuses an in-flight identical scan after it completes', async () => {
    const service = new SmartSearchService(() => true);
    let searches = 0;
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const internal = service as unknown as {
      store: {
        documentVersion: () => Promise<string>;
        search: () => Promise<{ document: SmartDocument; score: number }[]>;
      };
      searchDense: (
        vector: Buffer,
        filters: object,
        limit: number
      ) => Promise<{ document: SmartDocument; score: number }[]>;
    };
    internal.store = {
      async documentVersion() {
        return 'stable';
      },
      async search() {
        searches++;
        started();
        await gate;
        return [
          { document: { ...document, card: { ...document.card } }, score: 0.8 },
        ];
      },
    };
    const vector = Buffer.from([1, 2]);
    const first = internal.searchDense(vector, {}, 1);
    await startedPromise;
    const second = internal.searchDense(vector, {}, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(searches, 1);
    a[0].document.card.id = 'changed';
    assert.equal(b[0].document.card.id, 12);
  });

  it('bounds dense cache entries and expires them on monotonic time', async () => {
    let now = 0;
    const clock = mock.method(performance, 'now', () => now);
    const service = new SmartSearchService(() => true);
    let searches = 0;
    const internal = service as unknown as {
      store: {
        documentVersion: () => Promise<string>;
        search: () => Promise<{ document: SmartDocument; score: number }[]>;
      };
      searchDense: (
        vector: Buffer,
        filters: object,
        limit: number
      ) => Promise<{ document: SmartDocument; score: number }[]>;
    };
    internal.store = {
      async documentVersion() {
        return 'stable';
      },
      async search() {
        searches++;
        return [{ document, score: 0.8 }];
      },
    };
    try {
      for (let i = 0; i < 9; i++)
        await internal.searchDense(Buffer.from([i]), {}, 1);
      await internal.searchDense(Buffer.from([0]), {}, 1);
      await internal.searchDense(Buffer.from([0]), {}, 1);
      assert.equal(searches, 10);
      now = 30_001;
      await internal.searchDense(Buffer.from([0]), {}, 1);
      assert.equal(searches, 11);
    } finally {
      clock.mock.restore();
    }
  });

  it('does not serve a cached result when the index changes during a cache hit', async () => {
    const service = new SmartSearchService(() => true);
    let version = 'one';
    let readsBeforeChange = -1;
    let searches = 0;
    const internal = service as unknown as {
      store: {
        documentVersion: () => Promise<string>;
        search: () => Promise<{ document: SmartDocument; score: number }[]>;
      };
      searchDense: (
        vector: Buffer,
        filters: object,
        limit: number
      ) => Promise<{ document: SmartDocument; score: number }[]>;
    };
    internal.store = {
      async documentVersion() {
        if (readsBeforeChange === 0) version = 'two';
        if (readsBeforeChange >= 0) readsBeforeChange--;
        return version;
      },
      async search() {
        searches++;
        return [{ document: { ...document, title: version }, score: 0.8 }];
      },
    };
    const vector = Buffer.from([1, 2]);
    assert.equal(
      (await internal.searchDense(vector, {}, 1))[0].document.title,
      'one'
    );
    readsBeforeChange = 1;
    assert.equal(
      (await internal.searchDense(vector, {}, 1))[0].document.title,
      'two'
    );
    assert.equal(searches, 2);
  });

  it('bypasses the cache on version errors and clears it on reconfigure and close', async () => {
    const service = new SmartSearchService(() => true);
    let searches = 0;
    let versionError = false;
    let searchError = true;
    const internal = service as unknown as {
      start: () => void;
      store: {
        documentVersion: () => Promise<string>;
        search: () => Promise<{ document: SmartDocument; score: number }[]>;
        close: () => Promise<void>;
      };
      searchDense: (
        vector: Buffer,
        filters: object,
        limit: number
      ) => Promise<{ document: SmartDocument; score: number }[]>;
    };
    internal.start = () => undefined;
    internal.store = {
      async documentVersion() {
        if (versionError) throw new Error('version unavailable');
        return 'stable';
      },
      async search() {
        searches++;
        if (searchError) {
          searchError = false;
          throw new Error('scan failed');
        }
        return [{ document, score: 0.8 }];
      },
      async close() {},
    };
    const vector = Buffer.from([1, 2]);
    await assert.rejects(internal.searchDense(vector, {}, 1), /scan failed/);
    await internal.searchDense(vector, {}, 1);
    await internal.searchDense(vector, {}, 1);
    assert.equal(searches, 2);
    versionError = true;
    await internal.searchDense(vector, {}, 1);
    await internal.searchDense(vector, {}, 1);
    assert.equal(searches, 4);
    versionError = false;
    await internal.searchDense(vector, {}, 1);
    service.reconfigure();
    await internal.searchDense(vector, {}, 1);
    assert.equal(searches, 6);
    await service.close();
    await assert.rejects(internal.searchDense(vector, {}, 1), /unavailable/);
  });

  it('waits briefly for an in-flight dense scan instead of dropping the next request', async () => {
    const service = new SmartSearchService(() => true);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const internal = service as unknown as {
      store: { search: () => Promise<unknown[]> };
      searchDense: (
        vector: Buffer,
        filters: object,
        limit: number
      ) => Promise<unknown[]>;
    };
    internal.store = {
      async search() {
        calls++;
        if (calls === 1) await gate;
        return [];
      },
    };
    const first = internal.searchDense(Buffer.from([1]), {}, 1);
    const second = internal.searchDense(Buffer.from([1]), {}, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 2);
  });

  it('does not wait for a reranker model still downloading', async () => {
    const settings = getSettings().main;
    const original = settings.smartSearchRerank;
    settings.smartSearchRerank = true;
    const service = new SmartSearchService(() => true);
    const internal = service as unknown as {
      reranker: { phase: string };
      rerank: (
        query: string,
        candidates: { document: SmartDocument; score: number }[]
      ) => Promise<unknown[]>;
    };
    internal.reranker = { phase: 'downloading' };
    try {
      const candidates = [{ document, score: 0.5 }];
      const result = await Promise.race([
        internal.rerank('query', candidates),
        delay(500).then(() => {
          throw new Error('waited for download');
        }),
      ]);
      assert.deepEqual(result, candidates);
    } finally {
      settings.smartSearchRerank = original;
    }
  });
});

it('gives short reranker queries media context without rewriting longer multilingual descriptions', async () => {
  const embedded: string[] = [];
  const lexical: string[] = [];
  const remote: string[] = [];
  const engine = {
    phase: 'ready' as const,
    downloadBytes: 0,
    downloadTotal: 1,
    async start() {},
    stop() {},
    async embed(texts: string[]) {
      embedded.push(...texts);
      return [[1, 0]];
    },
  };
  const source: MetadataSource = {
    id: 'tmdb',
    async fetchOne() {
      return undefined;
    },
    async fetchPage() {
      return { documents: [], totalPages: 0 };
    },
    async searchRelated(query) {
      remote.push(query);
      return [];
    },
  };
  const service = new SmartSearchService(() => true, engine, source);
  const seen: string[] = [];
  const dense = [{ document, score: 0.5 }];
  const internal = service as unknown as {
    open: () => Promise<{
      searchLexical: (query: string) => Promise<unknown[]>;
    }>;
    searchDense: () => Promise<typeof dense>;
    rerank: (query: string, candidates: typeof dense) => Promise<typeof dense>;
    idleTimer?: NodeJS.Timeout;
  };
  internal.open = async () => ({
    searchLexical: async (query) => {
      lexical.push(query);
      return [];
    },
  });
  internal.searchDense = async () => dense;
  internal.rerank = async (query, candidates) => {
    seen.push(query);
    return candidates;
  };
  try {
    await service.search('space cats', {});
    await service.search('a family travels through space to a new home', {});
    const japanese = '第二次世界大戦中に科学者が原子爆弾を開発する映画';
    await service.search(japanese, {});
    assert.deepEqual(seen, [
      'A film or series about space cats',
      'a family travels through space to a new home',
      japanese,
    ]);
    const original = [
      'space cats',
      'a family travels through space to a new home',
      japanese,
    ];
    assert.deepEqual(embedded, original);
    assert.deepEqual(lexical, original);
    assert.deepEqual(remote, original);
  } finally {
    if (internal.idleTimer) clearTimeout(internal.idleTimer);
  }
});

it('blends reranking with initial retrieval so strong multilingual hits remain visible', async () => {
  const settings = getSettings().main;
  const originalRerank = settings.smartSearchRerank;
  const originalLimit = settings.smartSearchRerankCandidates;
  settings.smartSearchRerank = true;
  settings.smartSearchRerankCandidates = 40;
  const service = new SmartSearchService(() => true);
  const internal = service as unknown as {
    reranker: {
      phase: string;
      rerank: (query: string, docs: string[]) => Promise<number[]>;
    };
    rerank: (
      query: string,
      candidates: { document: SmartDocument; score: number }[]
    ) => Promise<{ document: SmartDocument }[]>;
    rerankerIdle?: NodeJS.Timeout;
    rerankerError?: string;
  };
  internal.reranker = {
    phase: 'ready',
    async rerank(_query, docs) {
      return docs.map((_, index) => index);
    },
  };
  try {
    internal.rerankerError = 'previous timeout';
    const candidates = Array.from({ length: 40 }, (_, index) => ({
      document: { ...document, sourceId: String(index) },
      score: 1 / (index + 1),
    }));
    const result = await internal.rerank('a multilingual query', candidates);
    assert.ok(result.findIndex((item) => item.document.sourceId === '2') < 10);
    assert.equal(service.status().reranker.error, undefined);
  } finally {
    if (internal.rerankerIdle) clearTimeout(internal.rerankerIdle);
    settings.smartSearchRerank = originalRerank;
    settings.smartSearchRerankCandidates = originalLimit;
  }
});

it('reuses exact reranker scores but re-evaluates changed queries and descriptions', async () => {
  const settings = getSettings().main;
  const previous = settings.smartSearchRerank;
  settings.smartSearchRerank = true;
  const service = new SmartSearchService(() => true);
  const calls: { query: string; docs: string[] }[] = [];
  const internal = service as unknown as {
    reranker: {
      phase: string;
      rerank: (query: string, docs: string[]) => Promise<number[]>;
    };
    rerank: (
      query: string,
      candidates: { document: SmartDocument; score: number }[]
    ) => Promise<{ document: SmartDocument; relevanceScore?: number }[]>;
    rerankerIdle?: NodeJS.Timeout;
  };
  internal.reranker = {
    phase: 'ready',
    async rerank(query, docs) {
      calls.push({ query, docs: [...docs] });
      return docs.map((doc) => (doc.includes('New description') ? 0.9 : 0.6));
    },
  };
  const candidate = (title: string, overview: string, voteAverage = 7) => ({
    document: { ...document, sourceId: title, title, overview, voteAverage },
    score: 0.5,
  });
  const a = candidate('A', 'Original description');
  const b = candidate('B', 'Another description');
  try {
    const first = await internal.rerank('a query', [a, b]);
    const second = await internal.rerank('a query', [a, b]);
    assert.deepEqual(second, first);
    assert.equal(calls.length, 1);
    const updated = await internal.rerank('a query', [
      candidate('A', 'Original description', 9),
      candidate('B', 'New description'),
    ]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].docs.length, 1);
    assert.equal(
      updated.find((x) => x.document.title === 'A')?.document.voteAverage,
      9
    );
    assert.equal(
      updated.find((x) => x.document.title === 'B')?.relevanceScore,
      0.9
    );
    await internal.rerank('another query', [a, b]);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].docs.length, 2);
  } finally {
    if (internal.rerankerIdle) clearTimeout(internal.rerankerIdle);
    settings.smartSearchRerank = previous;
  }
});

it('bounds reranker score cache entries and recomputes evicted scores', async () => {
  const settings = getSettings().main;
  const previousEnabled = settings.smartSearchRerank;
  const previousLimit = settings.smartSearchRerankCandidates;
  settings.smartSearchRerank = true;
  settings.smartSearchRerankCandidates = 80;
  const service = new SmartSearchService(() => true);
  const calls: number[] = [];
  const internal = service as unknown as {
    reranker: {
      phase: string;
      rerank: (query: string, docs: string[]) => Promise<number[]>;
    };
    rerank: (
      query: string,
      candidates: { document: SmartDocument; score: number }[]
    ) => Promise<unknown[]>;
    rerankerIdle?: NodeJS.Timeout;
  };
  internal.reranker = {
    phase: 'ready',
    async rerank(_query, docs) {
      calls.push(docs.length);
      return docs.map(() => 0.9);
    },
  };
  const candidates = Array.from({ length: 80 }, (_, index) => ({
    document: { ...document, sourceId: String(index), title: `Title ${index}` },
    score: 0.5,
  }));
  try {
    for (let i = 0; i < 13; i++)
      await internal.rerank(`query ${i}`, candidates);
    await internal.rerank('query 0', candidates);
    assert.equal(calls.length, 14);
    assert.equal(calls[13], 16);
  } finally {
    if (internal.rerankerIdle) clearTimeout(internal.rerankerIdle);
    settings.smartSearchRerank = previousEnabled;
    settings.smartSearchRerankCandidates = previousLimit;
  }
});

it('retains a valid cache hit if it expires during inference for other documents', async () => {
  const settings = getSettings().main;
  const previous = settings.smartSearchRerank;
  settings.smartSearchRerank = true;
  let now = 0;
  const clock = mock.method(performance, 'now', () => now);
  const service = new SmartSearchService(() => true);
  const internal = service as unknown as {
    reranker: {
      phase: string;
      rerank: (query: string, docs: string[]) => Promise<number[]>;
    };
    rerank: (
      query: string,
      candidates: { document: SmartDocument; score: number }[]
    ) => Promise<{ document: SmartDocument; relevanceScore?: number }[]>;
    rerankerIdle?: NodeJS.Timeout;
  };
  internal.reranker = {
    phase: 'ready',
    async rerank(_query, docs) {
      if (docs.some((doc) => doc.includes('New item'))) now += 2;
      return docs.map((doc) => (doc.includes('New item') ? 0.8 : 0.9));
    },
  };
  const a = { document: { ...document, title: 'Original item' }, score: 0.5 };
  const b = {
    document: { ...document, sourceId: 'new', title: 'New item' },
    score: 0.4,
  };
  try {
    await internal.rerank('query', [a]);
    now = 5 * 60 * 1000 - 1;
    const results = await internal.rerank('query', [a, b]);
    assert.equal(
      results.find((item) => item.document.title === 'Original item')
        ?.relevanceScore,
      0.9
    );
    assert.equal(
      results.find((item) => item.document.title === 'New item')
        ?.relevanceScore,
      0.8
    );
  } finally {
    clock.mock.restore();
    if (internal.rerankerIdle) clearTimeout(internal.rerankerIdle);
    settings.smartSearchRerank = previous;
  }
});

it('reuses scores without caching filtered results or old ratings', async () => {
  const settings = getSettings().main;
  const previous = settings.smartSearchRerank;
  settings.smartSearchRerank = true;
  const engine = {
    phase: 'ready' as const,
    downloadBytes: 0,
    downloadTotal: 1,
    async start() {},
    stop() {},
    async embed() {
      return [[1, 0]];
    },
  };
  const source: MetadataSource = {
    id: 'tmdb',
    async fetchOne() {
      return undefined;
    },
    async fetchPage() {
      return { documents: [], totalPages: 0 };
    },
  };
  const service = new SmartSearchService(() => true, engine, source);
  let calls = 0;
  const items = [
    {
      document: { ...document, sourceId: 'one', title: 'One', voteAverage: 9 },
      score: 0.8,
    },
    {
      document: { ...document, sourceId: 'two', title: 'Two', voteAverage: 5 },
      score: 0.7,
    },
  ];
  const internal = service as unknown as {
    open: () => Promise<{ searchLexical: () => Promise<unknown[]> }>;
    searchDense: (
      vector: Buffer,
      filters: { minRating?: number }
    ) => Promise<typeof items>;
    reranker: {
      phase: string;
      rerank: (query: string, docs: string[]) => Promise<number[]>;
    };
    idleTimer?: NodeJS.Timeout;
    rerankerIdle?: NodeJS.Timeout;
  };
  internal.open = async () => ({ searchLexical: async () => [] });
  internal.searchDense = async (_vector, filters) =>
    items.filter(
      (item) =>
        !filters.minRating || item.document.voteAverage >= filters.minRating
    );
  internal.reranker = {
    phase: 'ready',
    async rerank(_query, docs) {
      calls++;
      return docs.map(() => 0.9);
    },
  };
  try {
    assert.equal((await service.search('a short query', {})).length, 2);
    const filtered = await service.search('a short query', { minRating: 8 });
    assert.deepEqual(
      filtered.map((item) => item.document.sourceId),
      ['one']
    );
    assert.equal(calls, 1);
    items[0].document.voteAverage = 6;
    const updated = await service.search('a short query', {});
    assert.equal(
      updated.find((item) => item.document.sourceId === 'one')?.document
        .voteAverage,
      6
    );
    assert.equal(calls, 1);
  } finally {
    if (internal.idleTimer) clearTimeout(internal.idleTimer);
    if (internal.rerankerIdle) clearTimeout(internal.rerankerIdle);
    settings.smartSearchRerank = previous;
  }
});

it('discards cached and in-flight scores when the runtime is reconfigured', async () => {
  const settings = getSettings().main;
  const previous = settings.smartSearchRerank;
  settings.smartSearchRerank = true;
  const service = new SmartSearchService(() => true);
  let calls = 0;
  let finish: ((scores: number[]) => void) | undefined;
  const internal = service as unknown as {
    start: () => void;
    reranker: {
      phase: string;
      stop: () => void;
      rerank: () => Promise<number[]>;
    };
    rerank: (
      query: string,
      candidates: { document: SmartDocument; score: number }[]
    ) => Promise<{ reranked?: boolean }[]>;
    rerankerIdle?: NodeJS.Timeout;
  };
  internal.start = () => undefined;
  internal.reranker = {
    phase: 'ready',
    stop() {},
    async rerank() {
      calls++;
      if (calls === 2)
        return await new Promise((resolve) => {
          finish = resolve;
        });
      return [0.9];
    },
  };
  try {
    const candidates = [{ document, score: 0.5 }];
    await internal.rerank('cached', candidates);
    await internal.rerank('cached', candidates);
    assert.equal(calls, 1);
    const ongoing = internal.rerank('in flight', candidates);
    await Promise.resolve();
    assert.ok(finish);
    service.reconfigure();
    finish([0.9]);
    assert.equal((await ongoing)[0].reranked, undefined);
    await internal.rerank('cached', candidates);
    await internal.rerank('in flight', candidates);
    assert.equal(calls, 4);
  } finally {
    if (internal.rerankerIdle) clearTimeout(internal.rerankerIdle);
    settings.smartSearchRerank = previous;
  }
});

it('never caches failed reranker calls', async () => {
  const settings = getSettings().main;
  const previous = settings.smartSearchRerank;
  settings.smartSearchRerank = true;
  const service = new SmartSearchService(() => true);
  let calls = 0;
  const internal = service as unknown as {
    reranker: { phase: string; rerank: () => Promise<number[]> };
    rerank: (
      query: string,
      candidates: { document: SmartDocument; score: number }[]
    ) => Promise<{ reranked?: boolean }[]>;
    rerankerIdle?: NodeJS.Timeout;
  };
  internal.reranker = {
    phase: 'ready',
    async rerank() {
      calls++;
      if (calls === 1) throw new Error('temporary failure');
      return [0.9];
    },
  };
  try {
    const candidates = [{ document, score: 0.5 }];
    assert.equal(
      (await internal.rerank('query', candidates))[0].reranked,
      undefined
    );
    assert.equal(
      (await internal.rerank('query', candidates))[0].reranked,
      true
    );
    assert.equal(calls, 2);
  } finally {
    if (internal.rerankerIdle) clearTimeout(internal.rerankerIdle);
    settings.smartSearchRerank = previous;
  }
});

it('offers a deeper relevant candidate for reranking without rebuilding embeddings', async () => {
  let embeddingCalls = 0;
  const engine = {
    phase: 'ready' as const,
    downloadBytes: 0,
    downloadTotal: 1,
    async start() {},
    stop() {},
    async embed() {
      embeddingCalls++;
      return [[1, 0]];
    },
  };
  const source: MetadataSource = {
    id: 'tmdb',
    async fetchOne() {
      return undefined;
    },
    async fetchPage() {
      return { documents: [], totalPages: 0 };
    },
  };
  const service = new SmartSearchService(() => true, engine, source);
  const dense = Array.from({ length: 70 }, (_, index) => ({
    document: {
      ...document,
      title: `Candidate ${index}`,
      sourceId: String(index),
      voteCount: index === 50 ? 8000 : 0,
    },
    score: 0.6 - index * 0.001,
  }));
  let offered: string[] = [];
  const internal = service as unknown as {
    open: () => Promise<{ searchLexical: () => Promise<unknown[]> }>;
    searchDense: () => Promise<typeof dense>;
    rerank: (query: string, candidates: typeof dense) => Promise<typeof dense>;
    idleTimer?: NodeJS.Timeout;
  };
  internal.open = async () => ({ searchLexical: async () => [] });
  internal.searchDense = async () => dense;
  internal.rerank = async (_query, candidates) => {
    offered = candidates.slice(0, 40).map((item) => item.document.sourceId);
    return candidates;
  };
  try {
    await service.search('a plot description', {});
    assert.ok(offered.includes('0'));
    assert.ok(offered.includes('50'));
    assert.equal(embeddingCalls, 1);
  } finally {
    if (internal.idleTimer) clearTimeout(internal.idleTimer);
  }
});

it('does not boost a popular but irrelevant result as much as a relevant one', async () => {
  const engine = {
    phase: 'ready' as const,
    downloadBytes: 0,
    downloadTotal: 1,
    async start() {},
    stop() {},
    async embed() {
      return [[1, 0]];
    },
  };
  const source: MetadataSource = {
    id: 'tmdb',
    async fetchOne() {
      return undefined;
    },
    async fetchPage() {
      return { documents: [], totalPages: 0 };
    },
  };
  const service = new SmartSearchService(() => true, engine, source);
  const dense = [
    {
      document: {
        ...document,
        sourceId: 'unrelated',
        voteCount: 5000,
        voteAverage: 10,
      },
      score: 0.5,
    },
    {
      document: { ...document, sourceId: 'relevant', voteCount: 5000 },
      score: 0.5,
    },
  ];
  const internal = service as unknown as {
    open: () => Promise<{ searchLexical: () => Promise<unknown[]> }>;
    searchDense: () => Promise<typeof dense>;
    rerank: () => Promise<
      ((typeof dense)[number] & { relevanceScore: number })[]
    >;
    idleTimer?: NodeJS.Timeout;
  };
  internal.open = async () => ({ searchLexical: async () => [] });
  internal.searchDense = async () => dense;
  internal.rerank = async () =>
    dense.map((item, index) => ({
      ...item,
      score: 0.05,
      reranked: true,
      relevanceScore: index === 1 ? 0.95 : 0.05,
    }));
  try {
    const result = await service.search('a plot description', {});
    assert.equal(result[0].document.sourceId, 'relevant');
  } finally {
    if (internal.idleTimer) clearTimeout(internal.idleTimer);
  }
});

it('keeps a highly relevant obscure result ahead of an unrelated popular result', async () => {
  const settings = getSettings().main;
  const original = settings.smartSearchRerank;
  settings.smartSearchRerank = true;
  const engine = {
    phase: 'ready' as const,
    downloadBytes: 0,
    downloadTotal: 1,
    async start() {},
    stop() {},
    async embed() {
      return [[1, 0]];
    },
  };
  const source: MetadataSource = {
    id: 'tmdb',
    async fetchOne() {
      return undefined;
    },
    async fetchPage() {
      return { documents: [], totalPages: 0 };
    },
  };
  const service = new SmartSearchService(() => true, engine, source);
  const dense = [
    {
      document: {
        ...document,
        sourceId: 'relevant',
        title: 'Relevant',
        voteCount: 0,
      },
      score: 0.8,
    },
    {
      document: {
        ...document,
        sourceId: 'unrelated',
        title: 'Unrelated',
        voteCount: 10000,
      },
      score: 0.7,
    },
  ];
  const internal = service as unknown as {
    open: () => Promise<{ searchLexical: () => Promise<unknown[]> }>;
    searchDense: () => Promise<typeof dense>;
    reranker: { phase: string; rerank: () => Promise<number[]> };
    idleTimer?: NodeJS.Timeout;
    rerankerIdle?: NodeJS.Timeout;
  };
  internal.open = async () => ({ searchLexical: async () => [] });
  internal.searchDense = async () => dense;
  internal.reranker = {
    phase: 'ready',
    async rerank() {
      return [0.95, 0.01];
    },
  };
  try {
    const results = await service.search('a plot description', {});
    assert.equal(results[0].document.sourceId, 'relevant');
    assert.equal(results[0].reranked, true);
  } finally {
    settings.smartSearchRerank = original;
    if (internal.idleTimer) clearTimeout(internal.idleTimer);
    if (internal.rerankerIdle) clearTimeout(internal.rerankerIdle);
  }
});

it('keeps deeper audience candidates out when reranking is disabled or fails', async () => {
  const settings = getSettings().main;
  const original = settings.smartSearchRerank;
  const engine = {
    phase: 'ready' as const,
    downloadBytes: 0,
    downloadTotal: 1,
    async start() {},
    stop() {},
    async embed() {
      return [[1, 0]];
    },
  };
  const source: MetadataSource = {
    id: 'tmdb',
    async fetchOne() {
      return undefined;
    },
    async fetchPage() {
      return { documents: [], totalPages: 0 };
    },
  };
  const service = new SmartSearchService(() => true, engine, source);
  const dense = Array.from({ length: 70 }, (_, index) => ({
    document: {
      ...document,
      sourceId: String(index),
      voteCount: index === 50 ? 10000 : 0,
    },
    score: index === 0 ? 0.8 : 0.6 - index * 0.001,
  }));
  const internal = service as unknown as {
    open: () => Promise<{ searchLexical: () => Promise<unknown[]> }>;
    searchDense: () => Promise<typeof dense>;
    reranker: { phase: string; rerank: () => Promise<number[]> };
    idleTimer?: NodeJS.Timeout;
    rerankerIdle?: NodeJS.Timeout;
  };
  internal.open = async () => ({ searchLexical: async () => [] });
  internal.searchDense = async () => dense;
  internal.reranker = {
    phase: 'ready',
    async rerank() {
      throw new Error('unavailable');
    },
  };
  try {
    for (const enabled of [false, true]) {
      settings.smartSearchRerank = enabled;
      const results = await service.search('a plot description', {});
      assert.equal(results[0].document.sourceId, '0');
      assert.equal(results.length, 30);
      assert.ok(!results.some((item) => item.document.sourceId === '50'));
    }
  } finally {
    settings.smartSearchRerank = original;
    if (internal.idleTimer) clearTimeout(internal.idleTimer);
    if (internal.rerankerIdle) clearTimeout(internal.rerankerIdle);
  }
});

it('uses ratings only to resolve close library-recommendation matches', async () => {
  const engine = {
    phase: 'ready' as const,
    downloadBytes: 0,
    downloadTotal: 1,
    async start() {},
    stop() {},
    async embed() {
      return [];
    },
  };
  const source: MetadataSource = {
    id: 'tmdb',
    async fetchOne() {
      return undefined;
    },
    async fetchPage() {
      return { documents: [], totalPages: 0 };
    },
  };
  const service = new SmartSearchService(() => true, engine, source);
  const internal = service as unknown as {
    store: { find: () => Promise<{ document: SmartDocument; vector: Buffer }> };
    searchDense: () => Promise<{ document: SmartDocument; score: number }[]>;
  };
  internal.store = {
    async find() {
      return {
        document: { ...document, sourceId: 'seed' },
        vector: quantize([1, 0]),
      };
    },
  };
  internal.searchDense = async () => [
    {
      document: {
        ...document,
        sourceId: 'lower',
        voteAverage: 5,
        voteCount: 1000,
      },
      score: 0.8,
    },
    {
      document: {
        ...document,
        sourceId: 'higher',
        voteAverage: 9,
        voteCount: 1000,
      },
      score: 0.79,
    },
    ...Array.from({ length: 18 }, (_, index) => ({
      document: {
        ...document,
        sourceId: `other-${index}`,
        voteAverage: 0,
        voteCount: 0,
      },
      score: 0.6 - index * 0.01,
    })),
    {
      document: {
        ...document,
        sourceId: 'weak',
        voteAverage: 10,
        voteCount: 10000,
      },
      score: 0.2,
    },
  ];
  const result = await service.recommendations(
    [{ type: 'movie', id: 'seed' }],
    {}
  );
  assert.equal(result[0].document.sourceId, 'higher');
  assert.ok(result.findIndex((item) => item.document.sourceId === 'weak') > 1);
});

it('uses an established rating to break close similar-title ties', async () => {
  const settings = getSettings().main;
  const original = settings.smartSearchRerank;
  settings.smartSearchRerank = false;
  const engine = {
    phase: 'ready' as const,
    downloadBytes: 0,
    downloadTotal: 1,
    async start() {},
    stop() {},
    async embed() {
      return [];
    },
  };
  const source: MetadataSource = {
    id: 'tmdb',
    async fetchOne() {
      return undefined;
    },
    async fetchPage() {
      return { documents: [], totalPages: 0 };
    },
  };
  const service = new SmartSearchService(() => true, engine, source);
  const internal = service as unknown as {
    store: {
      find: () => Promise<{ document: SmartDocument; vector: Buffer }>;
      search: () => Promise<{ document: SmartDocument; score: number }[]>;
    };
  };
  internal.store = {
    async find() {
      return {
        document: { ...document, sourceId: 'seed' },
        vector: quantize([1, 0]),
      };
    },
    async search() {
      return [
        {
          document: {
            ...document,
            sourceId: 'lower',
            voteAverage: 5,
            voteCount: 1000,
          },
          score: 0.5,
        },
        {
          document: {
            ...document,
            sourceId: 'higher',
            voteAverage: 9,
            voteCount: 1000,
          },
          score: 0.5,
        },
      ];
    },
  };
  try {
    const result = await service.similar('movie', 'seed', {});
    assert.equal(result[0].document.sourceId, 'higher');
  } finally {
    settings.smartSearchRerank = original;
  }
});

it('keeps a stronger obscure similar title ahead of a weaker popular one', async () => {
  const settings = getSettings().main;
  const original = settings.smartSearchRerank;
  settings.smartSearchRerank = false;
  const engine = {
    phase: 'ready' as const,
    downloadBytes: 0,
    downloadTotal: 1,
    async start() {},
    stop() {},
    async embed() {
      return [];
    },
  };
  const source: MetadataSource = {
    id: 'tmdb',
    async fetchOne() {
      return undefined;
    },
    async fetchPage() {
      return { documents: [], totalPages: 0 };
    },
  };
  const service = new SmartSearchService(() => true, engine, source);
  const internal = service as unknown as {
    store: {
      find: () => Promise<{ document: SmartDocument; vector: Buffer }>;
      search: () => Promise<{ document: SmartDocument; score: number }[]>;
    };
  };
  internal.store = {
    async find() {
      return {
        document: { ...document, sourceId: 'seed' },
        vector: quantize([1, 0]),
      };
    },
    async search() {
      return [
        {
          document: {
            ...document,
            sourceId: 'relevant',
            voteAverage: 0,
            voteCount: 0,
          },
          score: 0.56,
        },
        {
          document: {
            ...document,
            sourceId: 'weak',
            voteAverage: 9,
            voteCount: 10000,
          },
          score: 0.5,
        },
      ];
    },
  };
  try {
    const result = await service.similar('movie', 'seed', {});
    assert.equal(result[0].document.sourceId, 'relevant');
  } finally {
    settings.smartSearchRerank = original;
  }
});

it('uses ephemeral description similarity to avoid promoting unrelated remote recommendations', async () => {
  const settings = getSettings().main;
  const original = settings.smartSearchRerank;
  settings.smartSearchRerank = false;
  const seed = { ...document, sourceId: '1', title: 'Seed' };
  const remoteNoise = {
    ...document,
    sourceId: '2',
    title: 'Noise',
    overview: 'Unrelated',
  };
  const remoteMatch = {
    ...document,
    sourceId: '3',
    title: 'Match',
    overview: 'Related',
  };
  const engine = {
    phase: 'ready' as const,
    downloadBytes: 0,
    downloadTotal: 1,
    async start() {},
    stop() {},
    async embed(texts: string[]) {
      return texts.map((text) =>
        text.includes('Unrelated') ? [0, 1] : [1, 0]
      );
    },
  };
  const source: MetadataSource = {
    id: 'tmdb',
    async fetchOne() {
      return undefined;
    },
    async fetchPage() {
      return { documents: [], totalPages: 0 };
    },
    async fetchRelated() {
      return [remoteNoise, remoteMatch];
    },
  };
  const service = new SmartSearchService(() => true, engine, source);
  const internal = service as unknown as {
    store: {
      find: () => Promise<{ document: SmartDocument; vector: Buffer }>;
      search: () => Promise<never[]>;
    };
  };
  internal.store = {
    async find() {
      return { document: seed, vector: quantize([1, 0]) };
    },
    async search() {
      return [];
    },
  };
  try {
    const result = await service.similar('movie', '1', {});
    assert.deepEqual(
      result.map((item) => item.document.sourceId),
      ['3', '2']
    );
  } finally {
    settings.smartSearchRerank = original;
  }
});
