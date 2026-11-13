import { SearchIndex } from '@server/lib/searchIndex';
import {
  decompressLines,
  importTitleStream,
  parseImdbTitles,
  parseTmdbTitles,
} from '@server/lib/searchIndex/importer';
import assert from 'node:assert/strict';
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
    ].join('\n');
    const result = [];
    for await (const row of parseImdbTitles(
      decompressLines(compressedLines(text))
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
      decompressLines(compressedLines(text)),
      'movie'
    ))
      result.push(row);
    assert.deepEqual(
      result.map((row) => row.sourceId),
      ['987895']
    );
    assert.equal(result[0].title, 'மாவீரன்');
  });

  it('keeps the existing index when a compressed import is truncated', async () => {
    const index = new SearchIndex(':memory:');
    await index.initialize();
    try {
      const text =
        'tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\ntt22543326\tmovie\tMaaveeran\tமாவீரன்\t0\n';
      await importTitleStream(
        index,
        'imdb',
        parseImdbTitles(decompressLines(compressedLines(text))),
        'v1'
      );
      await assert.rejects(
        importTitleStream(
          index,
          'imdb',
          parseImdbTitles(decompressLines(compressedLines(text, true))),
          'v2'
        )
      );
      assert.equal(await index.version('imdb'), 'v1');
      assert.equal((await index.search('maaveran'))[0]?.sourceId, 'tt22543326');
    } finally {
      await index.close();
    }
  });
});
