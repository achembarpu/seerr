export type SmartMediaType = 'movie' | 'tv';

/** The fields discovery needs from a metadata source. */
export interface SmartDocument {
  source: string;
  sourceId: string;
  mediaType: SmartMediaType;
  title: string;
  overview: string;
  originalLanguage: string;
  year: number | null;
  genreIds: number[];
  voteAverage: number;
  voteCount: number;
  popularity: number;
  /** A normalized Seerr search card, kept so queries need no per-result API calls. */
  card: Record<string, unknown>;
}

export interface SmartFilters {
  mediaType?: SmartMediaType;
  language?: string;
  yearFrom?: number;
  yearTo?: number;
  genre?: number;
  minRating?: number;
  minVotes?: number;
}

export interface MetadataSource {
  readonly id: string;
  fetchOne(
    mediaType: SmartMediaType,
    id: string,
    signal?: AbortSignal
  ): Promise<SmartDocument | undefined>;
  searchRelated?(
    query: string,
    filters: SmartFilters,
    language?: string
  ): Promise<SmartDocument[]>;
  fetchRelated?(
    mediaType: SmartMediaType,
    id: string,
    language?: string
  ): Promise<SmartDocument[]>;
  fetchPopular?(
    mediaType: SmartMediaType,
    page: number,
    signal?: AbortSignal
  ): Promise<{ documents: SmartDocument[]; totalPages: number }>;
  fetchChanges?(
    mediaType: SmartMediaType,
    from: string,
    to: string,
    page: number,
    signal?: AbortSignal
  ): Promise<{ ids: string[]; totalPages: number }>;
  fetchPage(
    mediaType: SmartMediaType,
    from: string,
    to: string,
    page: number,
    signal?: AbortSignal
  ): Promise<{
    documents: SmartDocument[];
    totalPages: number;
  }>;
}
