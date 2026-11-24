import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbKeyword,
  TmdbKeywordSearchResponse,
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import {
  mapMovieDetailsToResult,
  mapMovieResult,
  mapTvDetailsToResult,
  mapTvResult,
} from '@server/models/Search';
import { isAxiosError } from 'axios';
import {
  setTimeout as delay,
  setImmediate as nextTurn,
} from 'node:timers/promises';
import { TmdbKeywordCatalog, normalizeTmdbKeyword } from './keywordCatalog';
import type {
  MetadataSource,
  SmartDocument,
  SmartFilters,
  SmartMediaType,
} from './types';

const keywordNames = (keywords: TmdbKeyword[] | undefined) =>
  Array.isArray(keywords)
    ? [...new Set(keywords.map(({ name }) => name.trim()).filter(Boolean))]
    : undefined;

const ignoredKeywordTerms = new Set([
  'about',
  'with',
  'from',
  'that',
  'this',
  'film',
  'movie',
  'series',
  'show',
  'looking',
]);

export class TmdbMetadataSource implements MetadataSource {
  readonly id = 'tmdb';
  constructor(
    private readonly tmdb = new TheMovieDb({ timeout: 2000 }),
    private readonly keywordCatalog = new TmdbKeywordCatalog()
  ) {}

  private document(
    item: TmdbMovieResult | TmdbTvResult,
    mediaType: SmartMediaType,
    keywords?: string[]
  ): SmartDocument | undefined {
    if (!item.overview?.trim() || ('adult' in item && item.adult))
      return undefined;
    const movie = mediaType === 'movie' ? (item as TmdbMovieResult) : undefined;
    const tv = mediaType === 'tv' ? (item as TmdbTvResult) : undefined;
    return {
      source: this.id,
      sourceId: String(item.id),
      mediaType,
      title: movie?.title ?? tv?.name ?? '',
      overview: item.overview,
      originalLanguage: item.original_language ?? '',
      year:
        Number.parseInt(
          (movie?.release_date ?? tv?.first_air_date ?? '').slice(0, 4),
          10
        ) || null,
      genreIds: item.genre_ids ?? [],
      ...(keywords !== undefined && { keywords }),
      voteAverage: item.vote_average ?? 0,
      voteCount: item.vote_count ?? 0,
      popularity: item.popularity ?? 0,
      card: (mediaType === 'movie'
        ? mapMovieResult(item as TmdbMovieResult)
        : mapTvResult(item as TmdbTvResult)) as unknown as Record<
        string,
        unknown
      >,
    };
  }

  private async load(
    mediaType: SmartMediaType,
    id: number,
    language: string,
    signal?: AbortSignal
  ): Promise<{ item: TmdbMovieResult | TmdbTvResult; keywords?: string[] }> {
    if (mediaType === 'movie') {
      const details = await this.tmdb.getSmartMovieDetails(
        id,
        language,
        signal
      );
      return {
        item: mapMovieDetailsToResult(details),
        keywords: keywordNames(details.keywords?.keywords),
      };
    }
    const details = await this.tmdb.getSmartTvDetails(id, language, signal);
    return {
      item: mapTvDetailsToResult(details),
      keywords: keywordNames(details.keywords?.results),
    };
  }

  async fetchOne(
    mediaType: SmartMediaType,
    id: string,
    signal?: AbortSignal
  ): Promise<SmartDocument | undefined> {
    const number = Number(id);
    const { item, keywords } = await this.load(
      mediaType,
      number,
      'en-US',
      signal
    );
    if (
      !item.overview?.trim() &&
      item.original_language &&
      item.original_language !== 'en'
    ) {
      const localized = await this.load(
        mediaType,
        number,
        item.original_language,
        signal
      );
      return this.document(
        localized.item,
        mediaType,
        keywords ?? localized.keywords
      );
    }
    return this.document(item, mediaType, keywords);
  }

  async fetchKeywords(
    mediaType: SmartMediaType,
    id: string,
    signal?: AbortSignal
  ): Promise<string[] | undefined> {
    try {
      return keywordNames(
        await this.tmdb.getSmartKeywords(mediaType, Number(id), signal)
      );
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) return [];
      throw error;
    }
  }

  async fetchRelated(
    mediaType: SmartMediaType,
    id: string,
    language = 'en-US'
  ): Promise<SmartDocument[]> {
    const num = Number(id);
    const results = await Promise.allSettled(
      mediaType === 'movie'
        ? [
            this.tmdb.getMovieSimilar({ movieId: num, language }),
            this.tmdb.getMovieRecommendations({
              movieId: num,
              language,
            }),
          ]
        : [
            this.tmdb.getTvSimilar({ tvId: num, language }),
            this.tmdb.getTvRecommendations({ tvId: num, language }),
          ]
    );
    const lists = results.map((result) =>
      result.status === 'fulfilled' ? result.value.results : []
    );
    const documents = new Map<string, SmartDocument>();
    const [similar, recommendations] = lists;
    for (let i = 0; i < 20; i++)
      for (const list of [recommendations, similar]) {
        const item = list[i];
        if (!item || documents.has(String(item.id))) continue;
        const doc = this.document(item, mediaType);
        if (doc) documents.set(doc.sourceId, doc);
      }
    return [...documents.values()];
  }

  private async searchKeywordPages(
    query: string,
    root: string,
    signal?: AbortSignal
  ) {
    const known = this.keywordCatalog.prefixIds(root, 4);
    const request = (page: number, requestSignal?: AbortSignal) =>
      this.tmdb
        .searchKeyword({ query, page, signal: requestSignal })
        .catch(() => undefined);
    const lastPage = (first?: TmdbKeywordSearchResponse) => {
      const available =
        first &&
        Number.isSafeInteger(first.total_pages) &&
        first.total_pages >= 0
          ? Math.min(3, first.total_pages)
          : 3;
      if (available <= 1 || !first || !known?.length) return available;
      const found = new Set(
        (first.results ?? [])
          .filter(({ name }) => normalizeTmdbKeyword(name).startsWith(root))
          .map(({ id }) => id)
      );
      // A provider ID outside the catalog may signal the export is stale.
      return found.size === known.length && known.every((id) => found.has(id))
        ? 1
        : available;
    };
    const first = request(1, signal);
    // Small prefix sets usually fit on the first page. Let broad queries
    // retain parallel pagination so they do not pay an extra round trip.
    const early = known?.length
      ? { response: await first }
      : await Promise.race([
          first.then((response) => ({ response })),
          nextTurn(),
        ]);
    signal?.throwIfAborted();
    const earlyLimit = early ? lastPage(early.response) : 3;
    const pending = [2, 3]
      .filter((page) => page <= earlyLimit)
      .map((page) => {
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        const response = request(page, controller.signal).finally(() =>
          signal?.removeEventListener('abort', abort)
        );
        return { page, response, controller };
      });
    const pageOne = early ? early.response : await first;
    const limit = early ? earlyLimit : lastPage(pageOne);
    for (const { page, controller } of pending)
      if (page > limit) controller.abort();
    const more = await Promise.all(
      pending
        .filter(({ page }) => page <= limit)
        .map(({ response }) => response)
    );
    signal?.throwIfAborted();
    return [pageOne, ...more].flatMap((page) => page?.results ?? []);
  }

  prepareSearchKeywords(allowRefresh: boolean): void {
    void this.keywordCatalog.prepare(allowRefresh);
  }

  private searchTerms(query: string) {
    return (query.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])
      .filter((word) => !ignoredKeywordTerms.has(word))
      .slice(0, 2)
      .map((term) => ({
        term,
        root: term.length > 4 ? term.replace(/s$/u, '') : term,
      }))
      .filter(({ root }) => this.keywordCatalog.possiblyContains(root));
  }

  canSearchRelated(query: string): boolean {
    return this.searchTerms(query).length > 0;
  }

  /** Use TMDB keywords to find popular titles outside the partially built index. */
  async searchRelated(
    query: string,
    filters: SmartFilters,
    language = 'en-US',
    signal?: AbortSignal
  ): Promise<SmartDocument[]> {
    signal?.throwIfAborted();
    const terms = this.searchTerms(query);
    if (!terms.length) return [];
    // TMDB's keyword search is fuzzy and related compounds may occur on later
    // pages. Keep prefix-related keyword names rather than unrelated spellings.
    const groups = await Promise.all(
      terms.map(async ({ term, root }) => {
        const candidates = await this.searchKeywordPages(term, root, signal);
        const keywords = [
          ...new Map(
            candidates
              .filter((item) =>
                normalizeTmdbKeyword(item.name).startsWith(root)
              )
              .map((item) => [item.id, item])
          ).values(),
        ]
          .sort((a, b) => a.name.length - b.name.length)
          .slice(0, 5)
          .map((item) => item.id)
          .join('|');
        if (!keywords) return [];
        const opts = {
          keywords,
          language,
          page: 1,
          signal,
          sortBy: 'popularity.desc' as const,
          originalLanguage: filters.language,
          genre: filters.genre?.toString(),
          voteAverageGte: filters.minRating?.toString(),
          voteCountGte: filters.minVotes?.toString(),
        };
        // Start this term's discovery as soon as its keywords are ready.
        // Promise.all preserves the original term and media-type order.
        return Promise.allSettled([
          ...(!filters.mediaType || filters.mediaType === 'movie'
            ? [this.tmdb.getDiscoverMovies({ ...opts, includeVideo: false })]
            : []),
          ...(!filters.mediaType || filters.mediaType === 'tv'
            ? [this.tmdb.getDiscoverTv(opts)]
            : []),
        ]);
      })
    );
    signal?.throwIfAborted();
    const lists = groups
      .flat()
      .map((response) =>
        response.status === 'fulfilled' ? response.value.results : []
      );
    const documents: SmartDocument[] = [];
    for (let i = 0; i < 20; i++)
      for (const list of lists) {
        const item = list[i];
        if (!item) continue;
        const doc = this.document(item, 'title' in item ? 'movie' : 'tv');
        if (doc) documents.push(doc);
      }
    return documents;
  }

  async fetchPopular(
    mediaType: SmartMediaType,
    page: number,
    signal?: AbortSignal
  ) {
    return this.fetchPage(mediaType, '1900-01-01', '2100-12-31', page, signal);
  }

  async fetchChanges(
    mediaType: SmartMediaType,
    from: string,
    to: string,
    page: number,
    signal?: AbortSignal
  ): Promise<{ ids: string[]; totalPages: number }> {
    const response = await this.tmdb.getMediaChanges({
      mediaType,
      startDate: from,
      endDate: to,
      page,
      signal,
    });
    return {
      ids: response.results.map((item) => String(item.id)),
      totalPages: response.total_pages,
    };
  }

  async fetchPage(
    mediaType: SmartMediaType,
    dateFrom: string,
    dateTo: string,
    page: number,
    signal?: AbortSignal
  ): Promise<{ documents: SmartDocument[]; totalPages: number }> {
    const response = await this.tmdb.getSmartDiscover({
      mediaType,
      from: dateFrom,
      to: dateTo,
      page,
      signal,
    });
    const documents = response.results.map((item) =>
      this.document(item, mediaType)
    );
    const untranslated = [...response.results.entries()].filter(
      ([index, item]) =>
        !documents[index] &&
        !('adult' in item && item.adult) &&
        !item.overview?.trim() &&
        item.original_language &&
        item.original_language !== 'en'
    );
    for (let offset = 0; offset < untranslated.length; offset += 3) {
      signal?.throwIfAborted();
      const started = performance.now();
      const part = untranslated.slice(offset, offset + 3);
      const localized = await Promise.allSettled(
        part.map(([, item]) =>
          this.load(mediaType, item.id, item.original_language, signal)
        )
      );
      signal?.throwIfAborted();
      for (const [index, result] of localized.entries()) {
        if (result.status === 'rejected') {
          if (result.reason?.response?.status !== 404) throw result.reason;
          continue;
        }
        documents[part[index][0]] = this.document(
          result.value.item,
          mediaType,
          result.value.keywords
        );
      }
      const remaining = 250 - (performance.now() - started);
      if (remaining > 0 && offset + part.length < untranslated.length)
        await delay(remaining, undefined, { signal });
    }
    return {
      documents: documents.filter((item): item is SmartDocument => !!item),
      totalPages: response.total_pages,
    };
  }
}
