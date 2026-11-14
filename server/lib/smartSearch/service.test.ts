import { getSettings } from '@server/lib/settings';
import { mkdtemp, rm } from 'fs/promises';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'os';
import path from 'path';
import { SmartSearchService } from './service';
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

it('offers a relevant high-audience deep candidate to the reranker without re-embedding', async () => {
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
  const dense = Array.from({ length: 500 }, (_, index) => ({
    document: {
      ...document,
      sourceId: String(index),
      voteCount: index === 300 ? 10000 : 0,
    },
    score: 1 / (index + 1),
  }));
  let offered: string[] = [];
  const internal = service as unknown as {
    open: () => Promise<{ searchLexical: () => Promise<unknown[]> }>;
    searchDense: () => Promise<typeof dense>;
    rerank: (query: string, candidates: typeof dense) => Promise<typeof dense>;
    idleTimer?: NodeJS.Timeout;
  };
  internal.open = async () => ({
    async searchLexical() {
      return [];
    },
  });
  internal.searchDense = async () => dense;
  internal.rerank = async (_query, candidates) => {
    offered = candidates.slice(0, 40).map((item) => item.document.sourceId);
    return candidates;
  };
  try {
    await service.search('an ordinary descriptive query', {});
    assert.ok(offered.includes('300'));
    assert.ok(offered.includes('0'));
  } finally {
    if (internal.idleTimer) clearTimeout(internal.idleTimer);
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
