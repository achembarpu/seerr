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

class SearchIndexService {
  private index?: SearchIndex;
  private opening?: Promise<SearchIndex>;
  private refreshing = false;
  private timer?: NodeJS.Timeout;

  private async open(): Promise<SearchIndex> {
    if (this.index) return this.index;
    if (!this.opening) {
      this.opening = (async () => {
        const index = new SearchIndex(
          path.join(appDataPath(), 'search-index.sqlite3')
        );
        try {
          await index.initialize();
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

  start(): void {
    if (!this.timer) {
      this.timer = setInterval(
        () => {
          void this.refresh();
        },
        24 * 60 * 60 * 1000
      );
      this.timer.unref();
    }
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing || !getSettings().main.localTitleSearch) return;
    this.refreshing = true;
    try {
      const index = await this.open();
      for (const [name, task] of [
        ['IMDb titles', () => refreshImdb(index)],
        ['IMDb ratings', () => refreshImdbRatings(index)],
        ['TMDB movies', () => refreshTmdb(index, 'movie')],
        ['TMDB series', () => refreshTmdb(index, 'tv')],
      ] as const) {
        if (!getSettings().main.localTitleSearch) break;
        try {
          const count = await task();
          if (count !== undefined)
            logger.info(`Updated ${name} search index`, {
              label: 'Search',
              count,
            });
        } catch (error) {
          logger.warn(`Unable to update ${name} search index`, {
            label: 'Search',
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      logger.warn('Unable to open search index', {
        label: 'Search',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.refreshing = false;
    }
  }

  async search(query: string) {
    if (!getSettings().main.localTitleSearch || !this.index) return [];
    return this.index.search(query, 10);
  }
}

export default new SearchIndexService();
