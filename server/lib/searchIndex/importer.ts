import type {
  ImdbRating,
  IndexSource,
  IndexedTitle,
  SearchIndex,
} from '@server/lib/searchIndex';
import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import { userAgentRequestInterceptor } from '@server/utils/userAgent';
import axios from 'axios';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip } from 'node:zlib';

const imdbTypes: Record<string, IndexedTitle['mediaType']> = {
  movie: 'movie',
  tvMovie: 'movie',
  tvSeries: 'tv',
  tvMiniSeries: 'tv',
};

export async function* parseImdbRatings(
  lines: AsyncIterable<string>
): AsyncGenerator<ImdbRating> {
  let header = true;
  for await (const line of lines) {
    if (header) {
      if (line !== 'tconst\taverageRating\tnumVotes')
        throw new Error('Invalid IMDb ratings header');
      header = false;
      continue;
    }
    const [sourceId, , count] = line.split('\t');
    const votes = Number(count);
    if (/^tt\d+$/.test(sourceId) && Number.isSafeInteger(votes) && votes >= 0)
      yield { sourceId, votes };
  }
  if (header) throw new Error('IMDb ratings dataset is empty');
}

/** Read the official IMDb TSV without retaining the dataset in memory. */
export async function* parseImdbTitles(
  lines: AsyncIterable<string>
): AsyncGenerator<IndexedTitle> {
  let columns: Map<string, number> | undefined;
  for await (const line of lines) {
    if (!columns) {
      columns = new Map(line.split('\t').map((name, index) => [name, index]));
      for (const field of [
        'tconst',
        'titleType',
        'primaryTitle',
        'originalTitle',
        'isAdult',
      ]) {
        if (!columns.has(field))
          throw new Error(`IMDb title dataset is missing ${field}`);
      }
      continue;
    }
    const fields = line.split('\t');
    const get = (name: string): string =>
      fields[columns?.get(name) ?? -1] ?? '';
    const id = get('tconst');
    const title = get('primaryTitle');
    const original = get('originalTitle');
    const mediaType = imdbTypes[get('titleType')];
    if (
      !mediaType ||
      get('isAdult') !== '0' ||
      !/^tt\d+$/.test(id) ||
      !title ||
      title === '\\N'
    )
      continue;
    yield {
      sourceId: id,
      mediaType,
      title,
      originalTitle: original && original !== '\\N' ? original : title,
      popularity: 0,
    };
  }
  if (!columns) throw new Error('IMDb title dataset is empty');
}

/** Read TMDB's newline-delimited daily ID export. */
export async function* parseTmdbTitles(
  lines: AsyncIterable<string>,
  mediaType: IndexedTitle['mediaType']
): AsyncGenerator<IndexedTitle> {
  for await (const line of lines) {
    if (!line.trim()) continue;
    const data: unknown = JSON.parse(line);
    if (!data || typeof data !== 'object')
      throw new Error('Invalid TMDB title record');
    const row = data as Record<string, unknown>;
    const title =
      row[mediaType === 'movie' ? 'original_title' : 'original_name'];
    if (
      typeof row.id !== 'number' ||
      !Number.isSafeInteger(row.id) ||
      typeof title !== 'string'
    ) {
      throw new Error('Invalid TMDB title record');
    }
    if (!title || row.adult === true) continue;
    yield {
      sourceId: String(row.id),
      mediaType,
      title,
      originalTitle: title,
      popularity:
        typeof row.popularity === 'number' && Number.isFinite(row.popularity)
          ? Math.max(0, row.popularity)
          : 0,
    };
  }
}

export async function importTitleStream(
  index: SearchIndex,
  source: IndexSource,
  titles: AsyncIterable<IndexedTitle>,
  version: string,
  signal?: AbortSignal
): Promise<number> {
  await index.beginImport(source);
  let count = 0;
  let batch: IndexedTitle[] = [];
  try {
    for await (const title of titles) {
      signal?.throwIfAborted();
      batch.push(title);
      count++;
      if (batch.length === 1000) {
        await index.writeBatch(batch);
        batch = [];
      }
    }
    await index.writeBatch(batch);
    signal?.throwIfAborted();
    await index.finishImport(version);
    return count;
  } catch (error) {
    index.abortImport();
    throw error;
  }
}

const client = axios.create({ timeout: 120000, responseType: 'stream' });
client.interceptors.request.use(proxyRequestInterceptor);
client.interceptors.request.use(userAgentRequestInterceptor);

export async function* decompressLines(
  stream: Readable
): AsyncGenerator<string> {
  const gunzip = createGunzip();
  const decoder = new StringDecoder('utf8');
  let pending = '';
  stream.on('error', (error) => gunzip.destroy(error));
  stream.pipe(gunzip);
  try {
    for await (const chunk of gunzip) {
      pending += decoder.write(chunk as Buffer);
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        yield pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.end();
    if (pending) yield pending.replace(/\r$/, '');
  } finally {
    stream.destroy();
    gunzip.destroy();
  }
}

const previousExportDate = (daysAgo: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${month}_${day}_${date.getUTCFullYear()}`;
};

export async function refreshImdb(
  index: SearchIndex,
  signal?: AbortSignal
): Promise<number | undefined> {
  const previous = await index.version('imdb');
  const response = await client.get<Readable>(
    'https://datasets.imdbws.com/title.basics.tsv.gz',
    {
      headers: previous ? { 'If-None-Match': previous } : undefined,
      signal,
      validateStatus: (status) => status === 200 || status === 304,
    }
  );
  if (response.status === 304) {
    response.data.destroy();
    return undefined;
  }
  const version =
    typeof response.headers.etag === 'string' ? response.headers.etag : '';
  return importTitleStream(
    index,
    'imdb',
    parseImdbTitles(decompressLines(response.data)),
    version,
    signal
  );
}

export async function refreshImdbRatings(
  index: SearchIndex,
  signal?: AbortSignal
): Promise<number | undefined> {
  const previous = await index.version('imdb-ratings');
  const response = await client.get<Readable>(
    'https://datasets.imdbws.com/title.ratings.tsv.gz',
    {
      headers: previous ? { 'If-None-Match': previous } : undefined,
      signal,
      validateStatus: (status) => status === 200 || status === 304,
    }
  );
  if (response.status === 304) {
    response.data.destroy();
    return undefined;
  }
  const version =
    typeof response.headers.etag === 'string' ? response.headers.etag : '';
  await index.beginRatingsImport();
  let count = 0;
  let batch: ImdbRating[] = [];
  try {
    for await (const rating of parseImdbRatings(
      decompressLines(response.data)
    )) {
      signal?.throwIfAborted();
      batch.push(rating);
      count++;
      if (batch.length === 1000) {
        await index.writeRatingsBatch(batch);
        batch = [];
      }
    }
    await index.writeRatingsBatch(batch);
    signal?.throwIfAborted();
    await index.finishRatingsImport(version);
    return count;
  } catch (error) {
    index.abortImport();
    throw error;
  }
}

export async function refreshTmdb(
  index: SearchIndex,
  mediaType: IndexedTitle['mediaType'],
  signal?: AbortSignal
): Promise<number | undefined> {
  const source: IndexSource = mediaType === 'movie' ? 'tmdb-movie' : 'tmdb-tv';
  const previous = await index.version(source);
  const type = mediaType === 'movie' ? 'movie' : 'tv_series';
  for (const daysAgo of [1, 2]) {
    const date = previousExportDate(daysAgo);
    if (previous === date) return undefined;
    const response = await client.get<Readable>(
      `https://files.tmdb.org/p/exports/${type}_ids_${date}.json.gz`,
      { signal, validateStatus: (status) => status === 200 || status === 404 }
    );
    if (response.status === 404) {
      response.data.destroy();
      continue;
    }
    return importTitleStream(
      index,
      source,
      parseTmdbTitles(decompressLines(response.data), mediaType),
      date,
      signal
    );
  }
  throw new Error(`TMDB ${mediaType} exports are not available`);
}
