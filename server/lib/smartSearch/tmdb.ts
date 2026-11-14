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
import type { MetadataSource, SmartDocument, SmartMediaType } from './types';

export class TmdbMetadataSource implements MetadataSource {
  readonly id = 'tmdb';
  constructor(private readonly tmdb = new TheMovieDb()) {}

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
