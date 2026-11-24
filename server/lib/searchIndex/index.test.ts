import type { IndexedTitle, TitleMatch } from '@server/lib/searchIndex';
import { SearchIndex, normalizeTitle } from '@server/lib/searchIndex';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type sqlite3 from 'sqlite3';

type IndexTestMethods = {
  run: (
    sql: string,
    params?: (string | number | null)[],
    database?: sqlite3.Database
  ) => Promise<number>;
  all: (
    sql: string,
    params?: (string | number)[],
    database?: sqlite3.Database
  ) => Promise<unknown[]>;
  titlePairsBuild?: Promise<void>;
};

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
    const methods = index as unknown as IndexTestMethods;
    const run = methods.run.bind(index);
    methods.run = async (sql, params, database) => {
      const changed = await run(sql, params, database);
      if (sql.startsWith('INSERT INTO titles ')) {
        entered();
        await gate;
      }
      return changed;
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

it('uses the exact fallback during pair backfill and maintains indexed matches as imports change', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'seerr-search-pairs-'));
  const filename = path.join(directory, 'index.sqlite3');
  let index = new SearchIndex(filename);
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const old = index as unknown as IndexTestMethods;
    const oldRun = old.run.bind(index);
    old.run = async (sql, params, database) => {
      if (sql.startsWith('CREATE VIRTUAL TABLE IF NOT EXISTS title_pairs '))
        throw new Error('unrecognized option: contentless_delete');
      return oldRun(sql, params, database);
    };
    await index.initialize();
    await old.titlePairsBuild;
    await index.beginImport('imdb');
    await index.writeBatch([
      movie('tt1', 'Infernal Affairs', '無間道'),
      movie('tt2', 'Parasite', '기생충'),
      movie('tt3', 'a한c'),
      movie('tt4', 'abc'),
    ]);
    await index.finishImport('titles');
    assert.equal((await index.search('無間到'))[0]?.sourceId, 'tt1');
    await index.close();

    index = new SearchIndex(filename);
    const methods = index as unknown as IndexTestMethods;
    const run = methods.run.bind(index);
    methods.run = async (sql, params, database) => {
      if (sql.startsWith('INSERT OR REPLACE INTO title_pairs(rowid, pairs)')) {
        entered();
        await gate;
      }
      return run(sql, params, database);
    };
    await index.initialize();
    const build = methods.titlePairsBuild;
    assert.ok(build);
    await Promise.race([
      started,
      build.then(() => {
        throw new Error('Pair backfill did not reach the test gate');
      }),
    ]);
    const queries = ['無間到', '기생총', 'a한b', 'abé'];
    const fallback = await Promise.all(
      queries.map((query) => index.search(query, 10))
    );
    assert.deepEqual(
      fallback.map((matches) => matches[0]?.sourceId),
      ['tt1', 'tt2', 'tt3', 'tt4']
    );
    release();
    await build;
    const sql = mock.method(methods, 'all');
    try {
      assert.deepEqual(
        await Promise.all(queries.map((query) => index.search(query, 11))),
        fallback
      );
      assert.equal(
        sql.mock.calls.filter(({ arguments: [query] }) =>
          query.includes('title_pairs MATCH')
        ).length,
        3
      );

      await index.beginImport('imdb');
      await index.writeBatch([
        movie('tt1', 'Other Film'),
        movie('tt3', 'a한c'),
        movie('tt5', 'New Film', '無間山'),
      ]);
      await index.finishImport('refresh');
      assert.deepEqual(
        (await index.search('無間到')).map(({ sourceId }) => sourceId),
        ['tt5']
      );
      assert.deepEqual(await index.search('기생총'), []);
    } finally {
      sql.mock.restore();
    }
  } finally {
    release();
    await index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe('local title search index', () => {
  let index: SearchIndex;
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'seerr-search-test-'));
    index = new SearchIndex(path.join(directory, 'index.sqlite3'));
    await index.initialize();
  });
  afterEach(async () => {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('finds misspelled and substring names across scripts', async () => {
    await index.beginImport('imdb');
    await index.writeBatch([
      movie('tt10687070', 'Mandela', 'மண்டேலா', 1000),
      movie('tt39255646', 'Thaai Kizhavi', 'தாய் கிழவி', 100),
      movie('tt22543326', 'Maaveeran', 'மாவீரன்', 1000),
      movie('tt33988385', 'Karuppu', 'கருப்பு', 1000),
      movie('tt44090278', 'Baththa', 'பத்தா', 1000),
      movie('tt0133093', 'The Matrix', 'The Matrix', 10000),
      movie('tt0110413', 'Léon', 'Léon', 10000),
      movie('tt6751668', '기생충', '기생충', 10000),
      movie('tt0000001', '기생총각', '기생총각', 1),
    ]);
    await index.finishImport('v1');
    for (const [query, expected] of [
      ['mandla', 'tt10687070'],
      ['thai kilavi', 'tt39255646'],
      ['maaveran', 'tt22543326'],
      ['maveran', 'tt22543326'],
      ['karupu', 'tt33988385'],
      ['bathha', 'tt44090278'],
      ['trix', 'tt0133093'],
      ['leon', 'tt0110413'],
      ['மாவீரன்', 'tt22543326'],
    ]) {
      const matches = await index.search(query);
      assert.equal(matches[0]?.sourceId, expected, `query: ${query}`);
    }
    assert.ok(
      (await index.search('기생총')).some(
        (match) => match.sourceId === 'tt6751668'
      )
    );
    assert.equal(normalizeTitle('മാവീരൻ'), 'മാവീരൻ');
  });

  it('keeps mixed-script candidates and updates short Unicode matches on import', async () => {
    await index.beginImport('imdb');
    await index.writeBatch([
      movie('tt1', 'abc', 'abc', 100),
      movie('tt2', '無間道'),
      movie('tt3', '기생충'),
    ]);
    await index.finishImport('v1');
    assert.ok(
      (await index.search('abé')).some(({ sourceId }) => sourceId === 'tt1')
    );
    assert.ok(
      (await index.search('無間到')).some(({ sourceId }) => sourceId === 'tt2')
    );
    assert.ok(
      (await index.search('기생총')).some(({ sourceId }) => sourceId === 'tt3')
    );

    await index.beginImport('imdb');
    await index.writeBatch([movie('tt1', 'abc'), movie('tt2', 'Other Film')]);
    await index.finishImport('v2');
    assert.equal((await index.search('無間到')).length, 0);
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

  it('reconciles staged titles with the committed rows at publication', async () => {
    const concurrent = new SearchIndex(path.join(directory, 'index.sqlite3'));
    const methods = index as unknown as IndexTestMethods;
    await methods.titlePairsBuild;
    await concurrent.initialize();
    try {
      await index.beginImport('tmdb-movie');
      await index.writeBatch([movie('603', 'The Matrix')]);
      await concurrent.beginImport('tmdb-movie');
      await concurrent.writeBatch([movie('12', 'Finding Nemo')]);
      const run = methods.run.bind(index);
      const publish = mock.method(
        methods,
        'run',
        async (...args: Parameters<IndexTestMethods['run']>) => {
          if (args[0] === 'BEGIN IMMEDIATE' && !args[2])
            await concurrent.finishImport('earlier');
          return run(...args);
        }
      );
      try {
        await index.finishImport('latest');
      } finally {
        publish.mock.restore();
      }
      assert.equal(await index.version('tmdb-movie'), 'latest');
      assert.equal((await index.search('matrix'))[0]?.sourceId, '603');
      assert.deepEqual(await index.search('finding nemo'), []);
    } finally {
      await concurrent.close();
    }
  });

  it('imports titles and ratings across batch boundaries', async () => {
    const titles = Array.from({ length: 2001 }, (_, i) =>
      movie(`tt${i + 1}`, `Film Number ${i + 1}`)
    );
    await index.beginImport('imdb');
    await index.writeBatch(titles);
    await index.finishImport('titles');
    await index.beginRatingsImport();
    await index.writeRatingsBatch(
      titles.map((title, i) => ({ sourceId: title.sourceId, votes: i + 1 }))
    );
    await index.finishRatingsImport('ratings');
    const last = (await index.search('film number 2001')).find(
      (result) => result.sourceId === 'tt2001'
    );
    assert.equal(last?.popularity, 2001);
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
    const matches = await index.search('mandla');
    assert.equal(matches[0]?.sourceId, '1');
    assert.ok(matches.some((match) => match.sourceId === '2'));
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
    await index.beginRatingsImport();
    await index.writeRatingsBatch([{ sourceId: 'tt1', votes: 10 }]);
    await index.finishRatingsImport('ratings1');
    const methods = index as unknown as {
      findMatches: (
        query: string,
        grams: string[],
        limit: number
      ) => Promise<TitleMatch[]>;
    };
    const findMatches = mock.method(methods, 'findMatches');
    try {
      const abandoned = new AbortController();
      const disconnected = index.search('Matrix', 20, abandoned.signal);
      const active = Promise.all([
        index.search('matrix'),
        index.search('MATRIX'),
      ]);
      abandoned.abort();
      await assert.rejects(disconnected, { name: 'AbortError' });
      const [first, second] = await active;
      assert.equal(findMatches.mock.callCount(), 1);
      first[0].title = 'Changed by caller';
      assert.equal(second[0].title, 'The Matrix');
      assert.equal((await index.search('matrix'))[0].title, 'The Matrix');
      assert.equal(findMatches.mock.callCount(), 1);

      await index.beginImport('imdb');
      await index.writeBatch([movie('tt1', 'The Matrix')]);
      await index.finishImport('v2');
      assert.equal(await index.version('imdb'), 'v2');
      await index.beginRatingsImport();
      await index.writeRatingsBatch([{ sourceId: 'tt1', votes: 10 }]);
      await index.finishRatingsImport('ratings2');
      assert.equal(await index.version('imdb-ratings'), 'ratings2');
      assert.equal((await index.search('matrix'))[0].popularity, 10);
      assert.equal(findMatches.mock.callCount(), 1);

      await index.beginImport('imdb');
      await index.writeBatch([movie('tt1', 'Matrix Reloaded')]);
      await index.finishImport('v3');
      assert.equal((await index.search('matrix'))[0].title, 'Matrix Reloaded');
      assert.equal(findMatches.mock.callCount(), 2);
    } finally {
      findMatches.mock.restore();
    }
  });

  it('cancels a running title lookup and skips disconnected readers waiting behind it', async () => {
    await index.beginImport('imdb');
    await index.writeBatch([movie('tt1', 'The Matrix')]);
    await index.finishImport('v1');

    const methods = index as unknown as {
      findMatches: (
        query: string,
        grams: string[],
        limit: number,
        shortNonLatin: boolean,
        signal: AbortSignal
      ) => Promise<TitleMatch[]>;
    };
    const findMatches = methods.findMatches.bind(index);
    let begin: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const intercepted = mock.method(
      methods,
      'findMatches',
      async (...args: Parameters<typeof findMatches>) => {
        if (args[0] === 'running query') {
          const signal = args[4];
          begin();
          return new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          });
        }
        return findMatches(...args);
      }
    );
    try {
      const running = new AbortController();
      const first = index.search('running query', 20, running.signal);
      await started;
      const queued = new AbortController();
      const dropped = index.search('queued query', 20, queued.signal);
      const latest = index.search('matrix');
      queued.abort();
      await assert.rejects(dropped, { name: 'AbortError' });
      running.abort();
      await assert.rejects(first, { name: 'AbortError' });
      assert.equal((await latest)[0].sourceId, 'tt1');
      assert.deepEqual(
        intercepted.mock.calls.map(({ arguments: [query] }) => query),
        ['running query', 'matrix']
      );
    } finally {
      intercepted.mock.restore();
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
        limit: number,
        shortNonLatin: boolean,
        signal: AbortSignal
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
      async (...args: Parameters<typeof find>) => {
        const results = await find(...args);
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
