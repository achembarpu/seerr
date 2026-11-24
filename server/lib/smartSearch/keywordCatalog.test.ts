import TheMovieDb from '@server/api/themoviedb';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { TmdbKeywordCatalog } from './keywordCatalog';
import { TmdbMetadataSource } from './tmdb';

const hour = 60 * 60 * 1000;
const barberShop = { id: 50_001, name: 'Barber Shop' };
const barberCrew = { id: 50_003, name: 'Barber Crew' };
const catalogData = gzipSync(
  [
    ...Array.from({ length: 50_000 }, (_, id) => ({
      id: id + 1,
      name: `placeholder${id}`,
    })),
    barberShop,
    { id: 50_002, name: 'École du Rire' },
    barberCrew,
  ]
    .map((record) => JSON.stringify(record))
    .join('\n\n')
);

it('reads the existing catalog in manual mode and uses the same prefixes as live search', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-keywords-'));
  const filename = path.join(directory, 'tmdb-keywords.json.gz');
  try {
    await writeFile(filename, catalogData);
    let downloads = 0;
    const catalog = new TmdbKeywordCatalog(filename, async () => {
      downloads++;
      return catalogData;
    });
    const tmdb = new TheMovieDb();
    const source = new TmdbMetadataSource(tmdb, catalog);
    const keywords = context.mock.method(tmdb, 'searchKeyword', async () => ({
      page: 1,
      total_pages: 1,
      total_results: 1,
      results: [{ id: 50_001, name: 'Barber Shop' }],
    }));
    const discover = context.mock.method(
      tmdb,
      'getDiscoverMovies',
      async () => ({ results: [] })
    );

    assert.equal(source.canSearchRelated('zzzz'), true);
    source.prepareSearchKeywords(false);
    await catalog.prepare(false);
    assert.equal(downloads, 0);
    assert.equal(source.canSearchRelated('zzzz'), false);
    assert.equal(source.canSearchRelated('école'), true);
    assert.equal(source.canSearchRelated('zzzz barbers'), true);
    assert.equal(catalog.prefixIds('place', 4), undefined);
    await source.searchRelated('zzzz barbers', { mediaType: 'movie' });
    assert.deepEqual(
      keywords.mock.calls.map(({ arguments: [options] }) => options?.query),
      ['barbers']
    );
    assert.equal(discover.mock.calls[0].arguments[0]?.keywords, '50001');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('waits for the first page on small prefix sets and skips later pages only when complete', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-keywords-'));
  const filename = path.join(directory, 'tmdb-keywords.json.gz');
  try {
    await writeFile(filename, catalogData);
    const catalog = new TmdbKeywordCatalog(filename);
    await catalog.prepare(false);
    const lookups = async (firstResults: (typeof barberShop)[]) => {
      const tmdb = new TheMovieDb();
      const source = new TmdbMetadataSource(tmdb, catalog);
      let release: () => void = () => undefined;
      const firstPage = new Promise<void>((resolve) => {
        release = resolve;
      });
      const requested: number[] = [];
      context.mock.method(
        tmdb,
        'searchKeyword',
        async ({ page = 1 }: { page?: number }) => {
          requested.push(page);
          if (page === 1) await firstPage;
          return {
            page,
            total_pages: 3,
            results: page === 1 ? firstResults : page === 2 ? [barberCrew] : [],
          };
        }
      );
      const discover = context.mock.method(
        tmdb,
        'getDiscoverMovies',
        async () => ({
          results: [],
        })
      );
      const lookup = source.searchRelated('barber', { mediaType: 'movie' });
      await nextTurn();
      const beforeFirst = [...requested];
      release();
      await lookup;
      return {
        beforeFirst,
        requested,
        ids: discover.mock.calls[0].arguments[0]?.keywords,
      };
    };
    assert.deepEqual(await lookups([barberCrew, barberShop]), {
      beforeFirst: [1],
      requested: [1],
      ids: '50003|50001',
    });
    assert.deepEqual(await lookups([barberShop]), {
      beforeFirst: [1],
      requested: [1, 2, 3],
      ids: '50001|50003',
    });
    const newKeyword = { id: 50_004, name: 'Barber' };
    assert.deepEqual(await lookups([barberCrew, barberShop, newKeyword]), {
      beforeFirst: [1],
      requested: [1, 2, 3],
      ids: '50004|50003|50001',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('permits upstream lookups if the persisted catalog is missing, corrupt, incomplete or stale', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-keywords-'));
  const filename = path.join(directory, 'tmdb-keywords.json.gz');
  const verify = async () => {
    const catalog = new TmdbKeywordCatalog(filename);
    await catalog.prepare(false);
    assert.equal(catalog.possiblyContains('zzzz'), true);
    assert.equal(catalog.prefixIds('barber', 4), undefined);
  };
  try {
    await verify();
    await writeFile(filename, 'broken gzip');
    await verify();
    await writeFile(filename, gzipSync('{"id":1,"name":"valid but partial"}'));
    await verify();
    await writeFile(filename, catalogData);
    const oldDate = new Date(Date.now() - 49 * hour);
    await utimes(filename, oldDate, oldDate);
    await verify();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps the previous file on a failed refresh and retries after a backoff', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'smart-keywords-'));
  const filename = path.join(directory, 'tmdb-keywords.json.gz');
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  try {
    const copy = Buffer.from('unavailable catalog');
    await writeFile(filename, copy);
    let attempts = 0;
    const catalog = new TmdbKeywordCatalog(filename, async () => {
      if (++attempts === 1) throw new Error('temporary CDN failure');
      return catalogData;
    });
    await catalog.prepare(true);
    assert.deepEqual(await readFile(filename), copy);
    assert.equal(catalog.possiblyContains('zzzz'), true);
    await catalog.prepare(true);
    assert.equal(attempts, 1);

    now += hour;
    await Promise.all([catalog.prepare(true), catalog.prepare(true)]);
    assert.equal(attempts, 2);
    assert.deepEqual(await readFile(filename), catalogData);
    assert.deepEqual(await readdir(directory), ['tmdb-keywords.json.gz']);
    assert.equal(catalog.possiblyContains('zzzz'), false);
    await catalog.prepare(true);
    assert.equal(attempts, 2);
    now += 48 * hour;
    assert.equal(catalog.possiblyContains('zzzz'), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
