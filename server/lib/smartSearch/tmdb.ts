import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import {
  mapMovieDetailsToResult,
  mapMovieResult,
  mapTvDetailsToResult,
  mapTvResult,
} from '@server/models/Search';
import type {
  MetadataSource,
  SmartDocument,
  SmartFilters,
  SmartMediaType,
} from './types';

export class TmdbMetadataSource implements MetadataSource {
  readonly id = 'tmdb';
  constructor(private readonly tmdb = new TheMovieDb({ timeout: 2000 })) {}

  private document(
    item: TmdbMovieResult | TmdbTvResult,
    mediaType: SmartMediaType
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
  ): Promise<TmdbMovieResult | TmdbTvResult> {
    return mediaType === 'movie'
      ? mapMovieDetailsToResult(
          await this.tmdb.getSmartMovieDetails(id, language, signal)
        )
      : mapTvDetailsToResult(
          await this.tmdb.getSmartTvDetails(id, language, signal)
        );
  }

  async fetchOne(
    mediaType: SmartMediaType,
    id: string,
    signal?: AbortSignal
  ): Promise<SmartDocument | undefined> {
    const number = Number(id);
    const item = await this.load(mediaType, number, 'en-US', signal);
    if (
      !item.overview?.trim() &&
      item.original_language &&
      item.original_language !== 'en'
    ) {
      return this.document(
        await this.load(mediaType, number, item.original_language, signal),
        mediaType
      );
    }
    return this.document(item, mediaType);
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

  /** Use TMDB keywords to find popular titles outside the partially built index. */
  async searchRelated(
    query: string,
    filters: SmartFilters,
    language = 'en-US'
  ): Promise<SmartDocument[]> {
    const ignored = new Set([
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
    const terms = (query.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])
      .filter((word) => !ignored.has(word))
      .slice(0, 2);
    if (!terms.length) return [];
    // TMDB's keyword search is fuzzy and related compounds may occur on later
    // pages. Keep prefix-related keyword names rather than unrelated spellings.
    const keywordPages = await Promise.allSettled(
      terms.flatMap((term) =>
        [1, 2, 3].map((page) => this.tmdb.searchKeyword({ query: term, page }))
      )
    );
    const keywordGroups = terms
      .map((term, i) => {
        const root = term.length > 4 ? term.replace(/s$/u, '') : term;
        const candidates = keywordPages
          .slice(i * 3, i * 3 + 3)
          .flatMap((page) =>
            page.status === 'fulfilled' ? page.value.results : []
          );
        return [
          ...new Map(
            candidates
              .filter((item) =>
                item.name.toLowerCase().replace(/\s+/gu, '').startsWith(root)
              )
              .map((item) => [item.id, item])
          ).values(),
        ]
          .sort((a, b) => a.name.length - b.name.length)
          .slice(0, 5)
          .map((item) => item.id)
          .join('|');
      })
      .filter(Boolean);
    if (!keywordGroups.length) return [];
    const requests = keywordGroups.flatMap((keywords) => {
      const opts = {
        keywords,
        language,
        page: 1,
        sortBy: 'popularity.desc' as const,
        originalLanguage: filters.language,
        genre: filters.genre?.toString(),
        voteAverageGte: filters.minRating?.toString(),
        voteCountGte: filters.minVotes?.toString(),
      };
      return [
        ...(!filters.mediaType || filters.mediaType === 'movie'
          ? [this.tmdb.getDiscoverMovies({ ...opts, includeVideo: false })]
          : []),
        ...(!filters.mediaType || filters.mediaType === 'tv'
          ? [this.tmdb.getDiscoverTv(opts)]
          : []),
      ];
    });
    const responses = await Promise.allSettled(requests);
    const lists = responses.map((response) =>
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
    const documents: SmartDocument[] = [];
    for (const item of response.results) {
      if ('adult' in item && item.adult) continue;
      let document = this.document(item, mediaType);
      if (
        !document &&
        !item.overview?.trim() &&
        item.original_language &&
        item.original_language !== 'en'
      ) {
        try {
          document = this.document(
            await this.load(mediaType, item.id, item.original_language, signal),
            mediaType
          );
        } catch (error) {
          if (
            typeof error !== 'object' ||
            error === null ||
            !('response' in error) ||
            (error as { response?: { status?: number } }).response?.status !==
              404
          )
            throw error;
        }
      }
      if (document) documents.push(document);
    }
    return { documents, totalPages: response.total_pages };
  }
}
