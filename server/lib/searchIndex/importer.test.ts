import { SearchIndex } from '@server/lib/searchIndex';
import {
  decompressLineBatches,
  importTitleStream,
  parseImdbTitles,
  parseTmdbTitles,
} from '@server/lib/searchIndex/importer';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

const compressedLines = (text: string, truncate = false): Readable => {
  const bytes = gzipSync(text);
  const input = truncate ? bytes.subarray(0, bytes.length - 8) : bytes;
  // Split byte sequences to exercise multibyte UTF-8 across chunks.
  return Readable.from(Array.from(input, (byte) => Buffer.from([byte])));
};

describe('search index imports', () => {
  it('reads multilingual IMDb names and skips adult and unrelated records', async () => {
    const text = [
      'tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult',
      'tt22543326\tmovie\tMaaveeran\tமாவீரன்\t0',
      'tt2\ttvSeries\tExample Series\t\\N\t0',
      'tt3\ttvEpisode\tEpisode\tEpisode\t0',
      'tt4\tmovie\tAdult\tAdult\t1',
      'tt5\tconstructor\tInvalid\tInvalid\t0',
    ].join('\n');
    const result = [];
    for await (const row of parseImdbTitles(
      decompressLineBatches(compressedLines(text))
    ))
      result.push(row);
    assert.equal(result.length, 2);
    assert.equal(result[0].originalTitle, 'மாவீரன்');
    assert.equal(result[1].mediaType, 'tv');
    assert.equal(result[1].originalTitle, 'Example Series');
  });

  it('reads original TMDB titles and skips adult content', async () => {
    const text = [
      JSON.stringify({ id: 987895, original_title: 'மாவீரன்', popularity: 3 }),
      JSON.stringify({ id: 42, original_title: 'Adult', adult: true }),
    ].join('\n');
    const result = [];
    for await (const row of parseTmdbTitles(
      decompressLineBatches(compressedLines(text)),
      'movie'
    ))
      result.push(row);
    assert.deepEqual(
      result.map((row) => row.sourceId),
      ['987895']
    );
    assert.equal(result[0].title, 'மாவீரன்');
  });

  it('reads batched lines with reordered headers, split Unicode, and CRLF endings', async () => {
    const text = [
      'originalTitle\tisAdult\tprimaryTitle\ttitleType\ttconst',
      'மாவீரன்\t0\tMaaveeran\tmovie\ttt22543326',
      'Episode\t0\tEpisode\ttvEpisode\ttt2',
      'പത്താ\t0\tBaththa\tmovie\ttt44090278',
    ].join('\r\n');
    const rows = [];
    for await (const row of parseImdbTitles(
      decompressLineBatches(compressedLines(text))
    ))
      rows.push(row);
    assert.deepEqual(
      rows.map((row) => [row.sourceId, row.originalTitle]),
      [
        ['tt22543326', 'மாவீரன்'],
        ['tt44090278', 'പത്താ'],
      ]
    );
  });

  it('keeps the existing index when a compressed import is truncated', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'seerr-import-test-'));
    const index = new SearchIndex(path.join(directory, 'index.sqlite3'));
    await index.initialize();
    try {
      const text =
        'tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\ntt22543326\tmovie\tMaaveeran\tமாவீரன்\t0\n';
      await importTitleStream(
        index,
        'imdb',
        parseImdbTitles(decompressLineBatches(compressedLines(text))),
        'v1'
      );
      await assert.rejects(
        importTitleStream(
          index,
          'imdb',
          parseImdbTitles(decompressLineBatches(compressedLines(text, true))),
          'v2'
        )
      );
      assert.equal(await index.version('imdb'), 'v1');
      assert.equal((await index.search('maaveran'))[0]?.sourceId, 'tt22543326');
    } finally {
      await index.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the previous index when an import is cancelled before publication', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'seerr-import-test-'));
    const index = new SearchIndex(path.join(directory, 'index.sqlite3'));
    await index.initialize();
    try {
      const oldTitle = {
        sourceId: 'tt1',
        mediaType: 'movie' as const,
        title: 'Old Film',
        originalTitle: 'Old Film',
        popularity: 0,
      };
      async function* initial() {
        yield oldTitle;
      }
      await importTitleStream(index, 'imdb', initial(), 'v1');
      const controller = new AbortController();
      async function* interrupted() {
        yield { ...oldTitle, title: 'New Film' };
        controller.abort();
      }
      await assert.rejects(
        importTitleStream(index, 'imdb', interrupted(), 'v2', controller.signal)
      );
      assert.equal(await index.version('imdb'), 'v1');
      assert.equal((await index.search('old film'))[0]?.sourceId, 'tt1');
      assert.deepEqual(await index.search('new film'), []);
    } finally {
      await index.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
