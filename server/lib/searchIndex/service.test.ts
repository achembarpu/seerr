import { SearchIndex } from '@server/lib/searchIndex';
import { SearchIndexService } from '@server/lib/searchIndex/service';
import assert from 'node:assert/strict';
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
    const index = new SearchIndex(':memory:');
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
    }
  });

  it('cancels an active download and starts again if re-enabled immediately', async () => {
    let enabled = true;
    let attempts = 0;
    let started = false;
    const index = new SearchIndex(':memory:');
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
    }
  });
});
