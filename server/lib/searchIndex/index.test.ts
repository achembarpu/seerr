import type { IndexedTitle } from '@server/lib/searchIndex';
import { SearchIndex, normalizeTitle } from '@server/lib/searchIndex';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

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
});
