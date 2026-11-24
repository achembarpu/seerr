export const smartMediaTypes = ['movie', 'tv'] as const;
export type SmartMediaType = (typeof smartMediaTypes)[number];

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
  keywords?: string[];
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
  /** Undefined means keyword data was unavailable. An empty list is known. */
  fetchKeywords?(
    mediaType: SmartMediaType,
    id: string,
    signal?: AbortSignal
  ): Promise<string[] | undefined>;
  prepareSearchKeywords?(allowRefresh: boolean): void;
  canSearchRelated?(query: string): boolean;
  searchRelated?(
    query: string,
    filters: SmartFilters,
    language?: string,
    signal?: AbortSignal
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
