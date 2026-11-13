import type { IndexedTitle, TitleMatch } from '@server/lib/searchIndex';
import { SearchIndex, normalizeTitle } from '@server/lib/searchIndex';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

const movie = (
  sourceId: string,
  title: string,
  originalTitle = title,
  popularity = 0
): IndexedTitle => ({
  sourceId,
  mediaType: 'movie',
  title,
  originalTitle,
  popularity,
});

it('continues to search the committed index while an update is being published', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'seerr-search-test-'));
  const index = new SearchIndex(path.join(directory, 'index.sqlite3'));
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const published = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let updating: Promise<void> | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await index.initialize();
    await index.beginImport('imdb');
    await index.writeBatch([movie('tt1', 'Old Film')]);
    await index.finishImport('v1');
    await index.beginImport('imdb');
    await index.writeBatch([movie('tt1', 'New Film')]);

    // Pause with the new rows written but the transaction uncommitted.
    const methods = index as unknown as {
      run: (sql: string, params?: (string | number | null)[]) => Promise<void>;
    };
    const run = methods.run.bind(index);
    methods.run = async (sql, params) => {
      await run(sql, params);
      if (sql.startsWith('INSERT INTO titles ')) {
        entered();
        await gate;
      }
    };
    updating = index.finishImport('v2');
    await published;
    const results = await Promise.race([
      index.search('old film'),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Search waited for publication')),
          3000
        );
      }),
    ]);
    assert.equal(results[0]?.title, 'Old Film');
    assert.deepEqual(await index.search('new film'), []);
    release();
    await updating;
    assert.equal((await index.search('new film'))[0]?.title, 'New Film');
  } finally {
    if (timeout) clearTimeout(timeout);
    release();
    await updating?.catch(() => undefined);
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe('local title search index', () => {
  let index: SearchIndex;
  beforeEach(async () => {
    index = new SearchIndex(':memory:');
    await index.initialize();
  });
  afterEach(async () => index.close());

  it('finds misspelled and substring names across scripts', async () => {
    await index.beginImport('imdb');
    await index.writeBatch([
      movie('tt10687070', 'Mandela', 'மண்டேலா', 1000),
      movie('tt39255646', 'Thaai Kizhavi', 'தாய் கிழவி', 100),
      movie('tt22543326', 'Maaveeran', 'மாவீரன்', 1000),
      movie('tt33988385', 'Karuppu', 'கருப்பு', 1000),
      movie('tt44090278', 'Baththa', 'பத்தா', 1000),
      movie('tt0133093', 'The Matrix', 'The Matrix', 10000),
    ]);
    await index.finishImport('v1');
    for (const [query, expected] of [
      ['mandla', 'tt10687070'],
      ['thai kilavi', 'tt39255646'],
      ['maaveran', 'tt22543326'],
      ['karupu', 'tt33988385'],
      ['bathha', 'tt44090278'],
      ['trix', 'tt0133093'],
      ['மாவீரன்', 'tt22543326'],
    ]) {
      const matches = await index.search(query);
      assert.equal(matches[0]?.sourceId, expected, `query: ${query}`);
    }
    assert.equal(normalizeTitle('മാവീരൻ'), 'മാവീരൻ');
  });

  it('updates changed titles and removes records only after a successful import', async () => {
    await index.beginImport('imdb');
    await index.writeBatch([
      movie('tt1', 'Old Name'),
      movie('tt2', 'Removed Film'),
    ]);
    await index.finishImport('v1');
    await index.beginImport('imdb');
    await index.writeBatch([movie('tt1', 'New Name')]);
    index.abortImport();
    assert.equal((await index.search('old name'))[0]?.sourceId, 'tt1');
    assert.equal(await index.version('imdb'), 'v1');

    await index.beginImport('imdb');
    await index.writeBatch([movie('tt1', 'New Name')]);
    await index.finishImport('v2');
    assert.equal((await index.search('new name'))[0]?.sourceId, 'tt1');
    assert.deepEqual(await index.search('old name'), []);
    assert.deepEqual(await index.search('removed film'), []);
    assert.equal(await index.version('imdb'), 'v2');
  });

  it('rolls back a failed publication and preserves the previous index', async () => {
    await index.beginImport('imdb');
    await index.writeBatch([movie('tt1', 'Old Name')]);
    await index.finishImport('v1');
    await index.beginImport('imdb');
    await index.writeBatch([movie('tt1', 'New Name')]);
    await assert.rejects(index.finishImport(null as unknown as string));
    assert.equal((await index.search('old name'))[0]?.sourceId, 'tt1');
    assert.equal(await index.version('imdb'), 'v1');
  });

  it('does not replace one source when another source is refreshed', async () => {
    await index.beginImport('tmdb-movie');
    await index.writeBatch([movie('603', 'The Matrix')]);
    await index.finishImport('day1');
    await index.beginImport('imdb');
    await index.writeBatch([movie('tt10687070', 'Mandela')]);
    await index.finishImport('imdb1');
    assert.equal((await index.search('matrix'))[0]?.sourceId, '603');
  });

  it('refuses to publish an empty import', async () => {
    await index.beginImport('imdb');
    await assert.rejects(index.finishImport('empty'), /empty import/);
    assert.equal(await index.version('imdb'), undefined);
  });

  it('uses IMDb vote counts as a modest ranking signal and retains them on failure', async () => {
    await index.beginImport('imdb');
    await index.writeBatch([movie('tt1', 'Mandala'), movie('tt2', 'Mandela')]);
    await index.finishImport('titles');
    await index.beginRatingsImport();
    await index.writeRatingsBatch([{ sourceId: 'tt2', votes: 20000 }]);
    await index.finishRatingsImport('ratings');
    assert.equal((await index.search('mandla'))[0]?.sourceId, 'tt2');
    await index.beginRatingsImport();
    await assert.rejects(index.finishRatingsImport('empty'));
    index.abortImport();
    assert.equal((await index.search('mandla'))[0]?.sourceId, 'tt2');
    assert.equal(await index.version('imdb-ratings'), 'ratings');
  });

  it('can suggest a popular misspelled title alongside an obscure exact title', async () => {
    await index.beginImport('tmdb-movie');
    await index.writeBatch([
      movie('1', 'Mandla'),
      movie('2', 'Mandela', 'Mandela', 10000),
    ]);
    await index.finishImport('v1');
    assert.equal((await index.search('mandla'))[0]?.sourceId, '2');
  });

  it('refreshes changed ratings and removes ratings absent from the new dataset', async () => {
    await index.beginImport('imdb');
    await index.writeBatch([
      movie('tt1', 'Mandela'),
      movie('tt2', 'Mandela Film'),
    ]);
    await index.finishImport('titles');
    await index.beginRatingsImport();
    await index.writeRatingsBatch([
      { sourceId: 'tt1', votes: 10 },
      { sourceId: 'tt2', votes: 20 },
    ]);
    await index.finishRatingsImport('ratings1');
    assert.equal(
      (await index.search('mandela')).find(
        (result) => result.sourceId === 'tt1'
      )?.popularity,
      10
    );
    await index.beginRatingsImport();
    await index.writeRatingsBatch([{ sourceId: 'tt1', votes: 15 }]);
    await index.finishRatingsImport('ratings2');
    const results = await index.search('mandela');
    assert.equal(
      results.find((result) => result.sourceId === 'tt1')?.popularity,
      15
    );
    assert.equal(
      results.find((result) => result.sourceId === 'tt2')?.popularity,
      0
    );
  });

  it('shares repeated searches without sharing mutable results and invalidates on refresh', async () => {
    await index.beginImport('imdb');
    await index.writeBatch([movie('tt1', 'The Matrix')]);
    await index.finishImport('v1');
    const methods = index as unknown as {
      findMatches: (
        query: string,
        grams: string[],
        limit: number
      ) => Promise<TitleMatch[]>;
    };
    const findMatches = mock.method(methods, 'findMatches');
    try {
      const [first, second] = await Promise.all([
        index.search('matrix'),
        index.search('MATRIX'),
      ]);
      assert.equal(findMatches.mock.callCount(), 1);
      first[0].title = 'Changed by caller';
      assert.equal(second[0].title, 'The Matrix');
      assert.equal((await index.search('matrix'))[0].title, 'The Matrix');
      assert.equal(findMatches.mock.callCount(), 1);

      await index.beginImport('imdb');
      await index.writeBatch([movie('tt1', 'Matrix Reloaded')]);
      await index.finishImport('v2');
      assert.equal((await index.search('matrix'))[0].title, 'Matrix Reloaded');
      assert.equal(findMatches.mock.callCount(), 2);
    } finally {
      findMatches.mock.restore();
    }
  });

  it('does not cache an old search that completes after a refresh', async () => {
    await index.beginImport('imdb');
    await index.writeBatch([movie('tt1', 'The Matrix')]);
    await index.finishImport('v1');
    const methods = index as unknown as {
      findMatches: (
        query: string,
        grams: string[],
        limit: number
      ) => Promise<TitleMatch[]>;
    };
    const find = methods.findMatches.bind(index);
    let release: () => void = () => undefined;
    let ready: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const spy = mock.method(
      methods,
      'findMatches',
      async (query: string, grams: string[], limit: number) => {
        const results = await find(query, grams, limit);
        ready();
        await gate;
        return results;
      }
    );
    try {
      const pending = index.search('matrix');
      await started;
      await index.beginImport('imdb');
      await index.writeBatch([movie('tt1', 'Matrix Reloaded')]);
      await index.finishImport('v2');
      release();
      assert.equal((await pending)[0].title, 'The Matrix');
      assert.equal((await index.search('matrix'))[0].title, 'Matrix Reloaded');
    } finally {
      release();
      spy.mock.restore();
    }
  });
});
