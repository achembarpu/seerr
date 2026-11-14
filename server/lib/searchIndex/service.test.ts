import { SearchIndex } from '@server/lib/searchIndex';
import { SearchIndexService } from '@server/lib/searchIndex/service';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempts = 0; attempts < 500; attempts++) {
    if (predicate()) return;
    await delay(2);
  }
  throw new Error('Timed out waiting for search index');
};

describe('local search index lifecycle', () => {
  it('reports failures, schedules a retry, and allows a manual refresh', async () => {
    let enabled = true;
    let failMovie = true;
    const directory = await mkdtemp(path.join(tmpdir(), 'seerr-service-test-'));
    const index = new SearchIndex(path.join(directory, 'index.sqlite3'));
    const calls: string[] = [];
    const service = new SearchIndexService(
      () => enabled,
      () => index,
      async (source) => {
        calls.push(source);
        if (source === 'tmdb-movie' && failMovie)
          throw new Error('source unavailable');
        return undefined;
      }
    );
    try {
      service.start();
      await waitUntil(() => !service.status().refreshing);
      assert.deepEqual(service.status().failedSources, ['tmdb-movie']);
      assert.ok(service.status().sources.imdb.lastChecked);
      const retryAt = Date.parse(service.status().nextRefreshAt ?? '');
      assert.ok(retryAt > Date.now() + 59 * 60 * 1000);
      assert.ok(retryAt <= Date.now() + 60 * 60 * 1000);
      service.start();
      assert.equal(
        calls.length,
        4,
        'saving unrelated settings should not restart a refresh'
      );
      failMovie = false;
      assert.equal(service.refreshNow(), true);
      assert.equal(service.refreshNow(), false);
      await waitUntil(() => !service.status().refreshing);
      assert.deepEqual(service.status().failedSources, []);
      assert.ok(
        Date.parse(service.status().nextRefreshAt ?? '') >
          Date.now() + 23 * 60 * 60 * 1000
      );
    } finally {
      enabled = false;
      service.start();
      await index.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('cancels an active download and starts again if re-enabled immediately', async () => {
    let enabled = true;
    let attempts = 0;
    let started = false;
    const directory = await mkdtemp(path.join(tmpdir(), 'seerr-service-test-'));
    const index = new SearchIndex(path.join(directory, 'index.sqlite3'));
    const service = new SearchIndexService(
      () => enabled,
      () => index,
      async (source, _index, signal) => {
        if (source === 'imdb' && ++attempts === 1) {
          started = true;
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            })
          );
        }
        return undefined;
      }
    );
    try {
      service.start();
      await waitUntil(() => started);
      enabled = false;
      service.start();
      enabled = true;
      service.start();
      await waitUntil(() => attempts === 2 && !service.status().refreshing);
      assert.deepEqual(service.status().failedSources, []);
      assert.ok(service.status().nextRefreshAt);
    } finally {
      enabled = false;
      service.start();
      await index.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('opens an existing index in manual mode without downloading and refreshes only on request', async () => {
    let enabled = true;
    const directory = await mkdtemp(
      path.join(tmpdir(), 'seerr-service-manual-')
    );
    const filename = path.join(directory, 'index.sqlite3');
    const existing = new SearchIndex(filename);
    await existing.initialize();
    await existing.beginImport('imdb');
    await existing.writeBatch([
      {
        sourceId: 'tt1',
        mediaType: 'movie',
        title: 'Maaveeran',
        originalTitle: 'Maaveeran',
        popularity: 100,
      },
    ]);
    await existing.finishImport('v1');
    await existing.close();
    const index = new SearchIndex(filename);
    const calls: string[] = [];
    const service = new SearchIndexService(
      () => enabled,
      () => index,
      async (source) => {
        calls.push(source);
        return undefined;
      },
      () => 'manual'
    );
    try {
      service.start();
      assert.equal((await service.search('maveran'))[0]?.sourceId, 'tt1');
      assert.deepEqual(calls, []);
      assert.equal(service.status().sources.imdb.available, true);
      assert.equal(service.status().nextRefreshAt, undefined);
      assert.equal(service.refreshNow(), true);
      // Saving an unrelated setting must not abort a user-requested refresh.
      service.start();
      await waitUntil(() => !service.status().refreshing);
      assert.equal(calls.length, 4);
      assert.equal(service.status().nextRefreshAt, undefined);
      assert.equal((await service.search('maveran'))[0]?.sourceId, 'tt1');
    } finally {
      enabled = false;
      service.start();
      await index.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('cancels an active update when changed to manual without restarting it', async () => {
    let enabled = true;
    let schedule: 'daily' | 'manual' = 'daily';
    let entered = false;
    let calls = 0;
    const directory = await mkdtemp(
      path.join(tmpdir(), 'seerr-service-manual-')
    );
    const index = new SearchIndex(path.join(directory, 'index.sqlite3'));
    const service = new SearchIndexService(
      () => enabled,
      () => index,
      async (_source, _index, signal) => {
        calls++;
        if (calls === 1) {
          entered = true;
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            })
          );
        }
        return undefined;
      },
      () => schedule
    );
    try {
      service.start();
      await waitUntil(() => entered);
      schedule = 'manual';
      service.reconfigure();
      await waitUntil(() => !service.status().refreshing);
      assert.equal(calls, 1);
      assert.equal(service.status().nextRefreshAt, undefined);
      assert.equal(service.refreshNow(), true);
      await waitUntil(() => !service.status().refreshing);
      assert.equal(calls, 5);
      assert.equal(service.status().nextRefreshAt, undefined);
    } finally {
      enabled = false;
      service.start();
      await index.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('schedules a weekly refresh after a successful update', async () => {
    let enabled = true;
    const directory = await mkdtemp(
      path.join(tmpdir(), 'seerr-service-weekly-')
    );
    const index = new SearchIndex(path.join(directory, 'index.sqlite3'));
    const service = new SearchIndexService(
      () => enabled,
      () => index,
      async () => undefined,
      () => 'weekly'
    );
    try {
      service.start();
      await waitUntil(() => !service.status().refreshing);
      const refreshAt = Date.parse(service.status().nextRefreshAt ?? '');
      assert.ok(refreshAt > Date.now() + 6 * 24 * 60 * 60 * 1000);
      assert.ok(refreshAt <= Date.now() + 7 * 24 * 60 * 60 * 1000);
    } finally {
      enabled = false;
      service.start();
      await index.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
