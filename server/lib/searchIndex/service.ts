import { SearchIndex } from '@server/lib/searchIndex';
import {
  refreshImdb,
  refreshImdbRatings,
  refreshTmdb,
} from '@server/lib/searchIndex/importer';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { appDataPath } from '@server/utils/appDataVolume';
import path from 'path';

export type Source = 'imdb' | 'imdb-ratings' | 'tmdb-movie' | 'tmdb-tv';
export interface SearchIndexStatus {
  enabled: boolean;
  refreshing: boolean;
  currentSource?: Source;
  nextRefreshAt?: string;
  failedSources: Source[];
  sources: Record<Source, { available: boolean; lastChecked?: string }>;
}

const dailyInterval = 24 * 60 * 60 * 1000;
const weeklyInterval = 7 * dailyInterval;
const retryInterval = 60 * 60 * 1000;
const sources: Source[] = ['imdb', 'imdb-ratings', 'tmdb-movie', 'tmdb-tv'];

export class SearchIndexService {
  constructor(
    private readonly enabled: () => boolean = () =>
      getSettings().main.localTitleSearch,
    private readonly createIndex: () => SearchIndex = () =>
      new SearchIndex(path.join(appDataPath(), 'search-index.sqlite3')),
    private readonly refreshSource: (
      source: Source,
      index: SearchIndex,
      signal: AbortSignal
    ) => Promise<number | undefined> = (source, index, signal) => {
      switch (source) {
        case 'imdb':
          return refreshImdb(index, signal);
        case 'imdb-ratings':
          return refreshImdbRatings(index, signal);
        case 'tmdb-movie':
          return refreshTmdb(index, 'movie', signal);
        case 'tmdb-tv':
          return refreshTmdb(index, 'tv', signal);
      }
    },
    private readonly refreshInterval: () =>
      | 'daily'
      | 'weekly'
      | 'manual' = () =>
      getSettings().main.localTitleSearchRefreshInterval ?? 'daily'
  ) {}
  private index?: SearchIndex;
  private opening?: Promise<SearchIndex>;
  private controller?: AbortController;
  private timer?: NodeJS.Timeout;
  private nextRefreshAt?: string;
  private currentSource?: Source;
  private failedSources: Source[] = [];
  private sourceStatus: SearchIndexStatus['sources'] = {
    imdb: { available: false },
    'imdb-ratings': { available: false },
    'tmdb-movie': { available: false },
    'tmdb-tv': { available: false },
  };

  private async open(): Promise<SearchIndex> {
    if (this.index) return this.index;
    if (!this.opening) {
      this.opening = (async () => {
        const index = this.createIndex();
        try {
          await index.initialize();
          for (const source of sources) {
            this.sourceStatus[source] = {
              available: (await index.version(source)) !== undefined,
              lastChecked: await index.lastChecked(source),
            };
          }
          this.index = index;
          return index;
        } catch (error) {
          await index.close().catch(() => undefined);
          throw error;
        }
      })().finally(() => {
        this.opening = undefined;
      });
    }
    return this.opening;
  }

  status(): SearchIndexStatus {
    return {
      enabled: this.enabled(),
      refreshing: !!this.controller,
      currentSource: this.currentSource,
      nextRefreshAt: this.nextRefreshAt,
      failedSources: [...this.failedSources],
      sources: Object.fromEntries(
        sources.map((source) => [source, { ...this.sourceStatus[source] }])
      ) as SearchIndexStatus['sources'],
    };
  }

  /** Called on startup and after settings are saved. */
  start(): void {
    if (!this.enabled()) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.nextRefreshAt = undefined;
      this.controller?.abort();
      return;
    }
    if (this.refreshInterval() === 'manual') {
      // Manual mode still opens the committed index for searches; it never
      // triggers downloads unless the user explicitly requests a refresh.
      void this.open().catch((error) => {
        logger.warn('Unable to open local title search index', {
          label: 'Search',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    if (!this.controller && !this.timer) void this.refresh();
  }

  reconfigure(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRefreshAt = undefined;
    this.controller?.abort();
    this.start();
  }

  refreshNow(): boolean {
    if (!this.enabled() || this.controller) return false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRefreshAt = undefined;
    void this.refresh();
    return true;
  }

  private schedule(delay: number): void {
    this.nextRefreshAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.nextRefreshAt = undefined;
      void this.refresh();
    }, delay);
    this.timer.unref();
  }

  private async refresh(): Promise<void> {
    if (this.controller || !this.enabled()) return;
    const controller = new AbortController();
    this.controller = controller;
    this.failedSources = [];
    try {
      const index = await this.open();
      for (const source of sources) {
        if (controller.signal.aborted) break;
        this.currentSource = source;
        try {
          const count = await this.refreshSource(
            source,
            index,
            controller.signal
          );
          controller.signal.throwIfAborted();
          const lastChecked = new Date().toISOString();
          await index.markChecked(source, lastChecked);
          this.sourceStatus[source] = {
            available: (await index.version(source)) !== undefined,
            lastChecked,
          };
          if (count !== undefined)
            logger.info('Updated local title search index', {
              label: 'Search',
              source,
              count,
            });
        } catch (error) {
          if (controller.signal.aborted) break;
          this.failedSources.push(source);
          logger.warn('Unable to update local title search index', {
            label: 'Search',
            source,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.failedSources = [...sources];
        logger.warn('Unable to open local title search index', {
          label: 'Search',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.currentSource = undefined;
      this.controller = undefined;
      if (this.enabled()) {
        if (controller.signal.aborted) this.start();
        else if (this.refreshInterval() !== 'manual')
          this.schedule(
            this.failedSources.length
              ? retryInterval
              : this.refreshInterval() === 'weekly'
                ? weeklyInterval
                : dailyInterval
          );
      }
    }
  }

  async search(query: string, limit = 10) {
    if (!this.enabled()) return [];
    const index = await this.open();
    return this.enabled() ? index.search(query, limit) : [];
  }
}

export default new SearchIndexService();
