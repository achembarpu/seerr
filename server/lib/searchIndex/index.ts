import sqlite3 from 'sqlite3';
import jaro from 'wink-jaro-distance';

export type IndexSource = 'imdb' | 'tmdb-movie' | 'tmdb-tv';
export type IndexedMediaType = 'movie' | 'tv';

export interface IndexedTitle {
  sourceId: string;
  mediaType: IndexedMediaType;
  title: string;
  originalTitle: string;
  popularity: number;
}

export interface TitleMatch extends IndexedTitle {
  source: IndexSource;
  score: number;
}

export interface ImdbRating {
  sourceId: string;
  votes: number;
}

interface CandidateRow extends IndexedTitle {
  source: IndexSource;
  searchTitle: string;
  searchOriginalTitle: string;
}

const SEARCH_CACHE_SIZE = 128;

// Combining marks and joiners are part of words in scripts such as Tamil and
// Malayalam. Keep them instead of treating them as punctuation.
export const normalizeTitle = (value: string): string =>
  value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\u200c\u200d]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const similarity = (query: string, name: string): number => {
  if (!name) return 0;

  let score = jaro(query, name).similarity;
  if (name.includes(query)) score = Math.max(score, 0.9);
  if (!query.includes(' ')) {
    for (const word of name.split(' ')) {
      if (word.length >= query.length * 0.6) {
        score = Math.max(score, jaro(query, word).similarity);
      }
    }
  }
  return score;
};

const trigrams = (query: string): string[] => {
  const grams = new Set<string>();
  for (const word of query.split(' ')) {
    const chars = Array.from(word);
    for (let i = 0; i <= chars.length - 3; i++) {
      grams.add(chars.slice(i, i + 3).join(''));
    }
  }
  return [...grams].slice(0, 24);
};

/** A disposable, independently rebuildable search index. */
export class SearchIndex {
  private database: sqlite3.Database;
  private reader?: sqlite3.Database;
  private importing?: IndexSource;
  private publication?: Promise<void>;
  private revision = 0;
  private readonly searchCache = new Map<string, TitleMatch[]>();
  private readonly pendingSearches = new Map<string, Promise<TitleMatch[]>>();

  constructor(private readonly filename: string) {
    this.database = new sqlite3.Database(filename);
  }

  private run(
    sql: string,
    params: (string | number | null)[] = []
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.database.run(sql, params, (error) =>
        error ? reject(error) : resolve()
      );
    });
  }

  private all<T>(
    sql: string,
    params: (string | number)[] = [],
    database = this.database
  ): Promise<T[]> {
    return new Promise((resolve, reject) => {
      database.all<T>(sql, params, (error, rows) =>
        error ? reject(error) : resolve(rows)
      );
    });
  }

  async initialize(): Promise<void> {
    await this.run('PRAGMA journal_mode=WAL');
    await this.run(`CREATE TABLE IF NOT EXISTS titles (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      sourceId TEXT NOT NULL,
      mediaType TEXT NOT NULL,
      title TEXT NOT NULL,
      originalTitle TEXT NOT NULL,
      searchTitle TEXT NOT NULL,
      searchOriginalTitle TEXT NOT NULL,
      popularity REAL NOT NULL DEFAULT 0,
      UNIQUE(source, sourceId)
    )`);
    await this.run(`CREATE VIRTUAL TABLE IF NOT EXISTS title_fts USING fts5(
      searchTitle, searchOriginalTitle, content='titles', content_rowid='id', tokenize='trigram'
    )`);
    await this
      .run(`CREATE TRIGGER IF NOT EXISTS titles_insert AFTER INSERT ON titles BEGIN
      INSERT INTO title_fts(rowid, searchTitle, searchOriginalTitle)
      VALUES (new.id, new.searchTitle, new.searchOriginalTitle);
    END`);
    await this
      .run(`CREATE TRIGGER IF NOT EXISTS titles_delete AFTER DELETE ON titles BEGIN
      INSERT INTO title_fts(title_fts, rowid, searchTitle, searchOriginalTitle)
      VALUES ('delete', old.id, old.searchTitle, old.searchOriginalTitle);
    END`);
    await this
      .run(`CREATE TRIGGER IF NOT EXISTS titles_update AFTER UPDATE OF searchTitle, searchOriginalTitle ON titles BEGIN
      INSERT INTO title_fts(title_fts, rowid, searchTitle, searchOriginalTitle)
      VALUES ('delete', old.id, old.searchTitle, old.searchOriginalTitle);
      INSERT INTO title_fts(rowid, searchTitle, searchOriginalTitle)
      VALUES (new.id, new.searchTitle, new.searchOriginalTitle);
    END`);
    await this.run(
      'CREATE TABLE IF NOT EXISTS index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
    );
    await this.run(
      'CREATE TABLE IF NOT EXISTS imdb_votes (sourceId TEXT PRIMARY KEY, votes INTEGER NOT NULL) WITHOUT ROWID'
    );
    await this.run(
      'CREATE TEMP TABLE IF NOT EXISTS incoming_votes (sourceId TEXT PRIMARY KEY, votes INTEGER NOT NULL) WITHOUT ROWID'
    );
    await this.run(`CREATE TEMP TABLE IF NOT EXISTS incoming_titles (
      sourceId TEXT PRIMARY KEY,
      mediaType TEXT NOT NULL,
      title TEXT NOT NULL,
      originalTitle TEXT NOT NULL,
      searchTitle TEXT NOT NULL,
      searchOriginalTitle TEXT NOT NULL,
      popularity REAL NOT NULL
    ) WITHOUT ROWID`);
    // A separate connection can read the last committed WAL snapshot while a
    // large import is published. In-memory databases are connection-local.
    if (this.filename && this.filename !== ':memory:' && !this.reader) {
      this.reader = await new Promise<sqlite3.Database>((resolve, reject) => {
        const reader: sqlite3.Database = new sqlite3.Database(
          this.filename,
          sqlite3.OPEN_READONLY,
          (error) => (error ? reject(error) : resolve(reader))
        );
      });
    }
  }

  async beginImport(source: IndexSource): Promise<void> {
    if (this.importing)
      throw new Error('A search index import is already running');
    this.importing = source;
    try {
      await this.run('DELETE FROM incoming_titles');
    } catch (error) {
      this.importing = undefined;
      throw error;
    }
  }

  async writeBatch(titles: IndexedTitle[]): Promise<void> {
    if (!this.importing) throw new Error('No search index import is running');
    if (!titles.length) return;
    // Keep well below SQLite's parameter limit on older supported builds.
    for (let offset = 0; offset < titles.length; offset += 100) {
      const batch = titles.slice(offset, offset + 100);
      const values = batch.map(() => '(?,?,?,?,?,?,?)').join(',');
      const params = batch.flatMap((item) => {
        const title = normalizeTitle(item.title);
        return [
          item.sourceId,
          item.mediaType,
          item.title,
          item.originalTitle,
          title,
          item.originalTitle === item.title
            ? title
            : normalizeTitle(item.originalTitle),
          item.popularity,
        ];
      });
      await this.run(
        `INSERT OR REPLACE INTO incoming_titles VALUES ${values}`,
        params
      );
    }
  }

  async finishImport(version: string): Promise<void> {
    const source = this.importing;
    if (!source) throw new Error('No search index import is running');
    const [{ count }] = await this.all<{ count: number }>(
      'SELECT count(*) AS count FROM incoming_titles'
    );
    if (!count)
      throw new Error(
        'Refusing to replace the search index with an empty import'
      );
    const [previous] = await this.all<{ count: number }>(
      'SELECT count(*) AS count FROM titles WHERE source = ?',
      [source]
    );
    if (previous.count > 1000 && count < previous.count * 0.5) {
      throw new Error(
        'Refusing to replace the search index with an incomplete import'
      );
    }
    let releasePublication: () => void = () => undefined;
    this.publication = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    try {
      await this.run('BEGIN IMMEDIATE');
      await this.run(
        `INSERT INTO titles (source, sourceId, mediaType, title, originalTitle, searchTitle, searchOriginalTitle, popularity)
        SELECT ?, sourceId, mediaType, title, originalTitle, searchTitle, searchOriginalTitle, popularity FROM incoming_titles WHERE 1
        ON CONFLICT(source, sourceId) DO UPDATE SET
          mediaType=excluded.mediaType, title=excluded.title, originalTitle=excluded.originalTitle,
          searchTitle=excluded.searchTitle, searchOriginalTitle=excluded.searchOriginalTitle
        WHERE titles.mediaType != excluded.mediaType OR titles.title != excluded.title OR titles.originalTitle != excluded.originalTitle
          OR titles.searchTitle != excluded.searchTitle OR titles.searchOriginalTitle != excluded.searchOriginalTitle`,
        [source]
      );
      await this.run(
        `UPDATE titles SET popularity = (SELECT popularity FROM incoming_titles WHERE incoming_titles.sourceId = titles.sourceId)
        WHERE source = ? AND EXISTS (SELECT 1 FROM incoming_titles WHERE incoming_titles.sourceId = titles.sourceId AND incoming_titles.popularity != titles.popularity)`,
        [source]
      );
      await this.run(
        'DELETE FROM titles WHERE source = ? AND NOT EXISTS (SELECT 1 FROM incoming_titles WHERE incoming_titles.sourceId = titles.sourceId)',
        [source]
      );
      await this.run(
        'INSERT OR REPLACE INTO index_metadata(key, value) VALUES (?, ?)',
        [source, version]
      );
      await this.run('COMMIT');
      this.revision++;
      this.searchCache.clear();
      this.importing = undefined;
    } catch (error) {
      await this.run('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      this.publication = undefined;
      releasePublication();
    }
  }

  abortImport(): void {
    this.importing = undefined;
  }

  async beginRatingsImport(): Promise<void> {
    if (this.importing)
      throw new Error('A search index import is already running');
    this.importing = 'imdb';
    try {
      await this.run('DELETE FROM incoming_votes');
    } catch (error) {
      this.importing = undefined;
      throw error;
    }
  }

  async writeRatingsBatch(ratings: ImdbRating[]): Promise<void> {
    for (let offset = 0; offset < ratings.length; offset += 300) {
      const batch = ratings.slice(offset, offset + 300);
      await this.run(
        `INSERT OR REPLACE INTO incoming_votes VALUES ${batch.map(() => '(?,?)').join(',')}`,
        batch.flatMap(({ sourceId, votes }) => [sourceId, votes])
      );
    }
  }

  async finishRatingsImport(version: string): Promise<void> {
    const [{ count }] = await this.all<{ count: number }>(
      'SELECT count(*) AS count FROM incoming_votes'
    );
    if (!count)
      throw new Error('Refusing to replace IMDb ratings with an empty import');
    const [previous] = await this.all<{ count: number }>(
      'SELECT count(*) AS count FROM imdb_votes'
    );
    if (previous.count > 1000 && count < previous.count * 0.5)
      throw new Error(
        'Refusing to replace IMDb ratings with an incomplete import'
      );
    let release: () => void = () => undefined;
    this.publication = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await this.run('BEGIN IMMEDIATE');
      await this.run(`INSERT INTO imdb_votes(sourceId, votes)
        SELECT sourceId, votes FROM incoming_votes WHERE 1
        ON CONFLICT(sourceId) DO UPDATE SET votes = excluded.votes
        WHERE imdb_votes.votes != excluded.votes`);
      await this.run(
        'DELETE FROM imdb_votes WHERE NOT EXISTS (SELECT 1 FROM incoming_votes WHERE incoming_votes.sourceId = imdb_votes.sourceId)'
      );
      await this.run(
        'INSERT OR REPLACE INTO index_metadata(key, value) VALUES (?, ?)',
        ['imdb-ratings', version]
      );
      await this.run('COMMIT');
      this.revision++;
      this.searchCache.clear();
      this.importing = undefined;
    } catch (error) {
      await this.run('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      this.publication = undefined;
      release();
    }
  }

  async version(
    source: IndexSource | 'imdb-ratings'
  ): Promise<string | undefined> {
    const rows = await this.all<{ value: string }>(
      'SELECT value FROM index_metadata WHERE key = ?',
      [source]
    );
    return rows[0]?.value;
  }

  async lastChecked(
    source: IndexSource | 'imdb-ratings'
  ): Promise<string | undefined> {
    const rows = await this.all<{ value: string }>(
      'SELECT value FROM index_metadata WHERE key = ?',
      [`checked:${source}`]
    );
    return rows[0]?.value;
  }

  async markChecked(
    source: IndexSource | 'imdb-ratings',
    time: string
  ): Promise<void> {
    await this.run(
      'INSERT OR REPLACE INTO index_metadata(key, value) VALUES (?, ?)',
      [`checked:${source}`, time]
    );
  }

  async search(query: string, limit = 20): Promise<TitleMatch[]> {
    if (!this.reader) await this.publication;
    const normalized = normalizeTitle(query);
    const grams = trigrams(normalized);
    if (!grams.length) return [];
    const revision = this.revision;
    const key = `${revision}:${limit}:${normalized}`;
    const cached = this.searchCache.get(key);
    if (cached) {
      this.searchCache.delete(key);
      this.searchCache.set(key, cached);
      return cached.map((match) => ({ ...match }));
    }

    let pending = this.pendingSearches.get(key);
    if (!pending) {
      pending = this.findMatches(normalized, grams, limit);
      this.pendingSearches.set(key, pending);
    }
    try {
      const matches = await pending;
      if (revision === this.revision) {
        this.searchCache.delete(key);
        this.searchCache.set(key, matches);
        if (this.searchCache.size > SEARCH_CACHE_SIZE) {
          const oldest = this.searchCache.keys().next().value;
          if (oldest !== undefined) this.searchCache.delete(oldest);
        }
      }
      return matches.map((match) => ({ ...match }));
    } finally {
      if (this.pendingSearches.get(key) === pending)
        this.pendingSearches.delete(key);
    }
  }

  private async findMatches(
    normalized: string,
    grams: string[],
    limit: number
  ): Promise<TitleMatch[]> {
    const expression = grams
      .map((gram) => `"${gram.replace(/"/g, '""')}"`)
      .join(' OR ');
    const candidates = await this.all<CandidateRow>(
      `SELECT t.source, t.sourceId, t.mediaType, t.title, t.originalTitle, t.searchTitle, t.searchOriginalTitle, CASE WHEN t.source = 'imdb' THEN COALESCE(v.votes, 0) ELSE t.popularity END AS popularity
      FROM title_fts JOIN titles t ON t.id = title_fts.rowid
      LEFT JOIN imdb_votes v ON t.source = 'imdb' AND t.sourceId = v.sourceId
      WHERE title_fts MATCH ? ORDER BY rank LIMIT 5000`,
      [expression],
      this.reader
    );
    return candidates
      .map(({ searchTitle, searchOriginalTitle, ...candidate }) => {
        const titleScore = similarity(normalized, searchTitle);
        return {
          ...candidate,
          score:
            searchOriginalTitle === searchTitle
              ? titleScore
              : Math.max(
                  titleScore,
                  similarity(normalized, searchOriginalTitle)
                ),
        };
      })
      .filter((candidate) => candidate.score >= 0.78)
      .sort(
        (a, b) =>
          b.score +
            Math.min(0.06, Math.log10(b.popularity + 1) * 0.015) -
            (a.score + Math.min(0.06, Math.log10(a.popularity + 1) * 0.015)) ||
          a.sourceId.localeCompare(b.sourceId)
      )
      .slice(0, limit);
  }

  async close(): Promise<void> {
    const databases = this.reader
      ? [this.reader, this.database]
      : [this.database];
    await Promise.all(
      databases.map(
        (database) =>
          new Promise<void>((resolve, reject) =>
            database.close((error) => (error ? reject(error) : resolve()))
          )
      )
    );
  }
}
