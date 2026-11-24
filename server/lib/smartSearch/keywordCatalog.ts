import { appDataPath } from '@server/utils/appDataVolume';
import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import { userAgentRequestInterceptor } from '@server/utils/userAgent';
import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { open, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

const hour = 60 * 60 * 1000;
const day = 24 * hour;
const maxAge = 48 * hour;
const maxCompressedSize = 4 * 1024 * 1024;
const maxExpandedSize = 32 * 1024 * 1024;
// A healthy export contains about 100,000 rows. Do not reject searches based
// on a tiny or partially generated export.
const minCatalogSize = 50_000;

const client = axios.create({
  timeout: 15000,
  responseType: 'arraybuffer',
  decompress: false,
  maxContentLength: maxCompressedSize,
  maxRedirects: 2,
});
client.interceptors.request.use(proxyRequestInterceptor);
client.interceptors.request.use(userAgentRequestInterceptor);

export const normalizeTmdbKeyword = (name: string) =>
  name.toLowerCase().replace(/\s+/gu, '');

const decompress = promisify(gunzip);

async function parseCatalog(data: Buffer): Promise<string[]> {
  if (!data.length || data.length > maxCompressedSize)
    throw new Error('Invalid TMDB keyword export size');
  const lines = (
    await decompress(data, { maxOutputLength: maxExpandedSize })
  ).toString('utf8');
  const names: string[] = [];
  let start = 0;
  while (start < lines.length) {
    const newline = lines.indexOf('\n', start);
    const end = newline === -1 ? lines.length : newline;
    const line = lines.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    const row = JSON.parse(line) as { id?: number; name?: string } | null;
    if (
      !row ||
      !Number.isSafeInteger(row.id) ||
      typeof row.name !== 'string' ||
      !row.name.trim()
    )
      throw new Error('Invalid TMDB keyword record');
    names.push(normalizeTmdbKeyword(row.name));
    if (names.length % 4096 === 0) await nextTurn();
  }
  if (names.length < minCatalogSize)
    throw new Error('Incomplete TMDB keyword export');
  return names.sort();
}

async function downloadCatalog(now: number): Promise<Buffer> {
  // A new export is typically available by 08:00 UTC.
  const latest = now - 8 * hour;
  for (const timestamp of [latest, latest - day]) {
    const [year, month, date] = new Date(timestamp)
      .toISOString()
      .slice(0, 10)
      .split('-');
    const response = await client.get<Buffer>(
      `https://files.tmdb.org/p/exports/keyword_ids_${month}_${date}_${year}.json.gz`,
      { validateStatus: (status) => status === 200 || status === 404 }
    );
    if (response.status === 200) return response.data;
  }
  throw new Error('TMDB keyword exports are unavailable');
}

export class TmdbKeywordCatalog {
  private snapshot?: { names: string[]; updatedAt: number };
  private checkedDisk = false;
  private nextRefreshAt = 0;
  private retryDelay = hour;
  private task?: Promise<void>;

  constructor(
    private readonly filename = path.join(
      appDataPath(),
      'tmdb-keywords.json.gz'
    ),
    private readonly download = downloadCatalog
  ) {}

  prepare(allowRefresh: boolean): Promise<void> | undefined {
    if (this.task) return this.task;
    if (this.checkedDisk && (!allowRefresh || Date.now() < this.nextRefreshAt))
      return undefined;
    this.task = this.prepareCatalog(allowRefresh).finally(() => {
      this.task = undefined;
    });
    return this.task;
  }

  possiblyContains(prefix: string): boolean {
    const snapshot = this.snapshot;
    const age = snapshot ? Date.now() - snapshot.updatedAt : Infinity;
    if (!snapshot || age < 0 || age >= maxAge) return true;
    let left = 0;
    let right = snapshot.names.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (snapshot.names[middle] < prefix) left = middle + 1;
      else right = middle;
    }
    return snapshot.names[left]?.startsWith(prefix) ?? false;
  }

  private async prepareCatalog(allowRefresh: boolean): Promise<void> {
    if (!this.checkedDisk) {
      this.checkedDisk = true;
      await this.readCatalog().catch(() => undefined);
    }
    const now = Date.now();
    if (!allowRefresh || now < this.nextRefreshAt) return;
    try {
      const data = await this.download(now);
      const names = await parseCatalog(data);
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.filename);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      const updatedAt = Date.now();
      this.snapshot = { names, updatedAt };
      this.nextRefreshAt = updatedAt + day;
      this.retryDelay = hour;
    } catch {
      // Search still works while the CDN or disk is unavailable.
      this.nextRefreshAt = Date.now() + this.retryDelay;
      this.retryDelay = Math.min(day, this.retryDelay * 2);
    }
  }

  private async readCatalog(): Promise<void> {
    const file = await open(this.filename, 'r');
    try {
      const { size, mtimeMs } = await file.stat();
      const updatedAt = Math.floor(mtimeMs);
      const age = Date.now() - updatedAt;
      if (age < 0 || age >= maxAge || size <= 0 || size > maxCompressedSize)
        return;
      const data = Buffer.alloc(size);
      for (let offset = 0; offset < size; ) {
        const { bytesRead } = await file.read(
          data,
          offset,
          size - offset,
          offset
        );
        if (!bytesRead) return;
        offset += bytesRead;
      }
      this.snapshot = { names: await parseCatalog(data), updatedAt };
      this.nextRefreshAt = updatedAt + day;
    } finally {
      await file.close();
    }
  }
}
