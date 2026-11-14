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
