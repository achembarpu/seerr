import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { appDataPath } from '@server/utils/appDataVolume';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { EmbeddingEngine } from './engine';
import { documentHash, documentText, SmartStore } from './store';
import { TmdbMetadataSource } from './tmdb';
import type {
  MetadataSource,
  SmartDocument,
  SmartFilters,
  SmartMediaType,
} from './types';
import { quantize } from './vectors';

type Cursor = {
  year: number;
  mediaType: SmartMediaType;
  month: number;
  day?: number;
  page: number;
};
const firstYear = 1870;
const interval = 24 * 60 * 60 * 1000;
const retryInterval = 60 * 60 * 1000;

export class SmartSearchService {
  constructor(
    private readonly enabled: () => boolean = () =>
      !!getSettings().main.smartSearch,
    private readonly engine: Pick<
      EmbeddingEngine,
      'phase' | 'downloadBytes' | 'downloadTotal' | 'start' | 'stop' | 'embed'
    > = new EmbeddingEngine(),
    private readonly source: MetadataSource = new TmdbMetadataSource(),
    private readonly createStore: () => SmartStore = () =>
      new SmartStore(path.join(appDataPath(), 'smart-search.sqlite3'))
  ) {}
  private store?: SmartStore;
  private controller?: AbortController;
  private timer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private runtimeController = new AbortController();
  private cursor?: Cursor;
  private count = 0;
  private error?: string;
  private nextRefreshAt?: string;
  private inFlight?: Promise<void>;

  status() {
    return {
      enabled: this.enabled(),
      phase: this.engine.phase,
      indexing: !!this.controller,
      count: this.count,
      cursor: this.cursor,
      error: this.error,
      nextRefreshAt: this.nextRefreshAt,
      downloadBytes: this.engine.downloadBytes,
      downloadTotal: this.engine.downloadTotal,
    };
  }

  start(): void {
    if (!this.enabled()) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.nextRefreshAt = undefined;
      this.controller?.abort();
      this.runtimeController.abort();
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
      this.engine.stop();
      return;
    }
    if (!this.controller && !this.timer) {
      this.inFlight = this.refresh().catch((error) => {
        logger.error('Smart search failed', {
          label: 'Smart Search',
          errorMessage: String(error),
        });
      });
    }
  }

  refreshNow(): boolean {
    if (!this.enabled() || this.controller) return false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRefreshAt = undefined;
    this.start();
    return true;
  }

  private schedule(delay: number): void {
    this.nextRefreshAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.nextRefreshAt = undefined;
      this.start();
    }, delay);
    this.timer.unref();
  }

  private async startEngine(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.runtimeController.signal.aborted)
      this.runtimeController = new AbortController();
    await this.engine.start(
      this.controller?.signal ?? this.runtimeController.signal
    );
  }

  private unloadWhenIdle(): void {
    if (this.controller || !this.enabled()) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => {
        this.idleTimer = undefined;
        this.engine.stop();
      },
      15 * 60 * 1000
    );
    this.idleTimer.unref();
  }

  private async open(): Promise<SmartStore> {
    if (this.store) return this.store;
    const store = this.createStore();
    try {
      await store.initialize();
      this.count = await store.count();
      this.store = store;
      return store;
    } catch (error) {
      await store.close().catch(() => undefined);
      throw error;
    }
  }

  private async indexDocuments(
    store: SmartStore,
    mediaType: SmartMediaType,
    documents: SmartDocument[],
    signal: AbortSignal
  ): Promise<void> {
    const previous = await store.existing(
      this.source.id,
      mediaType,
      documents.map((doc) => doc.sourceId)
    );
    const changed = documents.filter(
      (doc) => previous.get(doc.sourceId)?.hash !== documentHash(doc)
    );
    const fresh = new Map<string, Buffer>();
    for (let offset = 0; offset < changed.length; offset += 8) {
      signal.throwIfAborted();
      const part = changed.slice(offset, offset + 8);
      const embeddings = await this.engine.embed(part.map(documentText));
      signal.throwIfAborted();
      for (let i = 0; i < part.length; i++)
        fresh.set(part[i].sourceId, quantize(embeddings[i]));
    }
    await store.upsertBatch(
      documents.map((document) => ({
        document,
        vector:
          fresh.get(document.sourceId) ??
          previous.get(document.sourceId)!.vector,
      }))
    );
  }

  private async updateChanges(
    store: SmartStore,
    since: string,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.source.fetchChanges)
      throw new Error('Source does not support incremental updates');
    const today = new Date().toISOString().slice(0, 10);
    const saved = await store.getState('changesCursor');
    let cursor: { date: string; mediaType: SmartMediaType; page: number } =
      saved ? JSON.parse(saved) : { date: since, mediaType: 'movie', page: 1 };
    while (cursor.date <= today) {
      signal.throwIfAborted();
      const batch = await this.source.fetchChanges(
        cursor.mediaType,
        cursor.date,
        cursor.date,
        cursor.page,
        signal
      );
      if (batch.totalPages > 500)
        throw new Error(
          `Too many changes for ${cursor.date}; a full reconciliation is required.`
        );
      const documents: SmartDocument[] = [];
      for (const id of batch.ids) {
        signal.throwIfAborted();
        await delay(250, undefined, { signal });
        try {
          const document = await this.source.fetchOne(
            cursor.mediaType,
            id,
            signal
          );
          if (document) documents.push(document);
          else await store.remove(this.source.id, cursor.mediaType, id);
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'response' in error &&
            (error as { response?: { status?: number } }).response?.status ===
              404
          )
            await store.remove(this.source.id, cursor.mediaType, id);
          else throw error;
        }
      }
      await this.indexDocuments(store, cursor.mediaType, documents, signal);
      this.count = await store.count();
      if (cursor.page < batch.totalPages)
        cursor = { ...cursor, page: cursor.page + 1 };
      else if (cursor.mediaType === 'movie')
        cursor = { ...cursor, mediaType: 'tv', page: 1 };
      else
        cursor = {
          date: new Date(Date.parse(`${cursor.date}T00:00:00Z`) + 86400000)
            .toISOString()
            .slice(0, 10),
          mediaType: 'movie',
          page: 1,
        };
      await store.setState('changesCursor', JSON.stringify(cursor));
    }
    await store.setState('lastUpdated', today);
    await store.setState('changesCursor', '');
  }

  private async refresh(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.error = undefined;
    let failed = false;
    try {
      const store = await this.open();
      await this.startEngine();
      const lastUpdated = await store.getState('lastUpdated');
      if (lastUpdated && this.source.fetchChanges) {
        await this.updateChanges(store, lastUpdated, controller.signal);
        return;
      }
      const saved = await store.getState('cursor');
      let scanStarted = await store.getState('scanStarted');
      if (!saved || !scanStarted) {
        scanStarted = new Date().toISOString().slice(0, 10);
        await store.setState('scanStarted', scanStarted);
        await store.setState('lastUpdated', '');
        await store.setState('changesCursor', '');
      }
      this.cursor = saved
        ? (JSON.parse(saved) as Cursor)
        : {
            year: new Date().getUTCFullYear() + 1,
            mediaType: 'movie',
            month: 0,
            page: 1,
          };
      while (this.cursor.year >= firstYear) {
        controller.signal.throwIfAborted();
        const cursor: Cursor = this.cursor;
        const { year, month, page, mediaType } = cursor;
        const day = cursor.day ?? 0;
        const from = month
          ? `${year}-${String(month).padStart(2, '0')}-${String(day || 1).padStart(2, '0')}`
          : `${year}-01-01`;
        const last = month
          ? new Date(Date.UTC(year, month, 0)).getUTCDate()
          : 31;
        const to = month
          ? `${year}-${String(month).padStart(2, '0')}-${String(day || last).padStart(2, '0')}`
          : `${year}-12-31`;
        const batch = await this.source.fetchPage(
          mediaType,
          from,
          to,
          page,
          controller.signal
        );
        controller.signal.throwIfAborted();
        if (batch.totalPages > 500 && month === 0) {
          this.cursor = { year, month: 1, page: 1, mediaType };
          await store.setState('cursor', JSON.stringify(this.cursor));
          continue;
        }
        if (batch.totalPages > 500 && month && !day) {
          this.cursor = { year, month, day: 1, page: 1, mediaType };
          await store.setState('cursor', JSON.stringify(this.cursor));
          continue;
        }
        if (batch.totalPages > 500)
          throw new Error(
            `TMDB returned more than 500 pages for ${mediaType} ${from}–${to}; indexing stopped to avoid missing titles.`
          );
        await this.indexDocuments(
          store,
          mediaType,
          batch.documents,
          controller.signal
        );
        this.count = await store.count();
        if (page < Math.min(batch.totalPages, 500))
          this.cursor = { year, mediaType, month, day, page: page + 1 };
        else if (day && day < last)
          this.cursor = { year, mediaType, month, day: day + 1, page: 1 };
        else if (month && month < 12)
          this.cursor = { year, mediaType, month: month + 1, page: 1 };
        else if (mediaType === 'movie')
          this.cursor = { year, mediaType: 'tv', month: 0, page: 1 };
        else
          this.cursor = {
            year: year - 1,
            mediaType: 'movie',
            month: 0,
            page: 1,
          };
        await store.setState('cursor', JSON.stringify(this.cursor));
      }
      await store.setState('cursor', '');
      await store.setState('lastUpdated', scanStarted);
      await store.setState('scanStarted', '');
      this.cursor = undefined;
    } catch (error) {
      if (!controller.signal.aborted) {
        failed = true;
        this.error = error instanceof Error ? error.message : String(error);
        logger.warn('Smart search indexing failed', {
          label: 'Smart Search',
          errorMessage: this.error,
        });
      }
    } finally {
      this.controller = undefined;
      this.unloadWhenIdle();
      if (this.enabled()) {
        if (controller.signal.aborted) this.start();
        else this.schedule(failed ? retryInterval : interval);
      }
    }
  }

  async search(query: string, filters: SmartFilters) {
    if (!this.enabled() || !this.store) return [];
    await this.startEngine();
    try {
      const [vector] = await this.engine.embed([
        query.replace(/\s+/gu, ' ').trim(),
      ]);
      return await this.store.search(quantize(vector), filters);
    } finally {
      this.unloadWhenIdle();
    }
  }

  private async seed(type: SmartMediaType, id: string) {
    if (!this.store) return undefined;
    let seed = await this.store.find(this.source.id, type, id);
    try {
      if (!seed) {
        await this.startEngine();
        const document = await this.source.fetchOne(
          type,
          id,
          this.runtimeController.signal
        );
        if (document) {
          const [embedding] = await this.engine.embed([documentText(document)]);
          const vector = quantize(embedding);
          await this.store.upsert(document, vector);
          this.count = await this.store.count();
          seed = { document, vector };
        }
      }
      return seed;
    } finally {
      this.unloadWhenIdle();
    }
  }

  async similar(type: SmartMediaType, id: string, filters: SmartFilters) {
    if (!this.enabled() || !this.store) return [];
    const seed = await this.seed(type, id);
    if (!seed) return [];
    return (await this.store.search(seed.vector, filters, 31))
      .filter(
        (item) =>
          item.document.mediaType !== type || item.document.sourceId !== id
      )
      .slice(0, 30);
  }

  async recommendations(
    seeds: { type: SmartMediaType; id: string }[],
    filters: SmartFilters
  ) {
    if (!this.enabled() || !this.store) return [];
    const unique = [
      ...new Map(
        seeds.map((seed) => [`${seed.type}:${seed.id}`, seed])
      ).values(),
    ].slice(0, 5);
    const vectors: Buffer[] = [];
    for (const item of unique) {
      const result = await this.seed(item.type, item.id);
      if (result) vectors.push(result.vector);
    }
    if (!vectors.length) return [];
    const aggregate = Array.from({ length: vectors[0].length }, (_, index) =>
      vectors.reduce((sum, vector) => sum + vector.readInt8(index), 0)
    );
    if (!aggregate.some((value) => value !== 0)) return [];
    const exclude = new Set(unique.map((item) => `${item.type}:${item.id}`));
    return (await this.store.search(quantize(aggregate), filters, 35))
      .filter(
        (item) =>
          !exclude.has(`${item.document.mediaType}:${item.document.sourceId}`)
      )
      .slice(0, 30);
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.controller?.abort();
    this.runtimeController.abort();
    this.engine.stop();
    await this.inFlight;
    await this.store?.close();
    this.store = undefined;
  }
}
export default new SmartSearchService();
