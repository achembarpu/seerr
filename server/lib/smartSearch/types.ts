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
  /** A source-specific search card, kept so queries need no per-result API calls. */
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
    id: string
  ): Promise<SmartDocument | undefined>;
  fetchChanges?(
    mediaType: SmartMediaType,
    from: string,
    to: string,
    page: number
  ): Promise<{ ids: string[]; totalPages: number }>;
  fetchPage(
    mediaType: SmartMediaType,
    from: string,
    to: string,
    page: number
  ): Promise<{
    documents: SmartDocument[];
    totalPages: number;
  }>;
}
