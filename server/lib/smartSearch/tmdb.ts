import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import {
  mapMovieDetailsToResult,
  mapTvDetailsToResult,
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
      card: { ...item, media_type: mediaType },
    };
  }

  async fetchOne(
    mediaType: SmartMediaType,
    id: string
  ): Promise<SmartDocument | undefined> {
    const number = Number(id);
    const item =
      mediaType === 'movie'
        ? mapMovieDetailsToResult(
            await this.tmdb.getMovieSearchDetails({
              movieId: number,
              language: 'en-US',
            })
          )
        : mapTvDetailsToResult(
            await this.tmdb.getTvSearchDetails({
              tvId: number,
              language: 'en-US',
            })
          );
    if (
      !item.overview?.trim() &&
      item.original_language &&
      item.original_language !== 'en'
    ) {
      const translated =
        mediaType === 'movie'
          ? mapMovieDetailsToResult(
              await this.tmdb.getMovieSearchDetails({
                movieId: number,
                language: item.original_language,
              })
            )
          : mapTvDetailsToResult(
              await this.tmdb.getTvSearchDetails({
                tvId: number,
                language: item.original_language,
              })
            );
      return this.document(translated, mediaType);
    }
    return this.document(item, mediaType);
  }

  async fetchChanges(
    mediaType: SmartMediaType,
    from: string,
    to: string,
    page: number
  ): Promise<{ ids: string[]; totalPages: number }> {
    const response = await this.tmdb.getMediaChanges({
      mediaType,
      startDate: from,
      endDate: to,
      page,
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
    page: number
  ): Promise<{ documents: SmartDocument[]; totalPages: number }> {
    const response =
      mediaType === 'movie'
        ? await this.tmdb.getDiscoverMovies({
            page,
            language: 'en-US',
            originalLanguage: 'all',
            primaryReleaseDateGte: dateFrom,
            primaryReleaseDateLte: dateTo,
            includeVideo: false,
          })
        : await this.tmdb.getDiscoverTv({
            page,
            language: 'en-US',
            originalLanguage: 'all',
            firstAirDateGte: dateFrom,
            firstAirDateLte: dateTo,
          });
    const documents: SmartDocument[] = [];
    for (const item of response.results) {
      let document = this.document(item, mediaType);
      if (
        !document &&
        !item.overview?.trim() &&
        item.original_language &&
        item.original_language !== 'en'
      ) {
        document = await this.fetchOne(mediaType, String(item.id));
      }
      if (document) documents.push(document);
    }
    return { documents, totalPages: response.total_pages };
  }
}
