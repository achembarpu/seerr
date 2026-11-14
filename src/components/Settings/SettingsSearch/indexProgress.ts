type MediaType = 'movie' | 'tv';

interface ProgressStatus {
  indexing: boolean;
  popularCursor?: { type: MediaType; page: number; totalPages?: number };
  cursor?: {
    mediaType: MediaType;
    year: number;
    month: number;
    day?: number;
    page: number;
  };
}

/** Keep saved cursors visible when a scan is paused, without calling them active. */
export const indexProgress = (status: ProgressStatus) => {
  const popular = status.popularCursor && {
    ...status.popularCursor,
    paused: !status.indexing,
  };
  const cursor = status.cursor;
  const chronological =
    cursor && (!status.indexing || !popular)
      ? {
          mediaType: cursor.mediaType,
          page: cursor.page,
          paused: !status.indexing,
          period: [
            cursor.year,
            cursor.month || undefined,
            cursor.day || undefined,
          ]
            .filter(Boolean)
            .map((part, index) =>
              index ? String(part).padStart(2, '0') : String(part)
            )
            .join('-'),
        }
      : undefined;
  return { popular, chronological };
};
