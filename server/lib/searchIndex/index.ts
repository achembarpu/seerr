import logger from '@server/logger';
import { setTimeout as delay } from 'node:timers/promises';
import sqlite3 from 'sqlite3';
import { normalizeTitle, prepareTitleSimilarity, titleRank } from './ranking';

export { normalizeTitle } from './ranking';

export type IndexSource = 'imdb' | 'tmdb-movie' | 'tmdb-tv';
export type IndexedMediaType = 'movie' | 'tv';
export const titleImportBatchSize = 2000;

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
const NON_ASCII_TITLES = nonAsciiTitles();
const PAIR_BATCH_SIZE = 4000;
const READ_MMAP_BYTES = 0x7fff0000;

function nonAsciiTitles(prefix = ''): string {
  return `(${prefix}searchTitle GLOB '*[^ -~]*' OR ${prefix}searchOriginalTitle GLOB '*[^ -~]*')`;
}

// Two Unicode code points map to a single ASCII FTS token by encoding their
// UTF-8 bytes as hex. Preserve marks and mixed-script pairs without relying
// on the tokenizer to segment a title.
const pairTokens = (titles: string): string => `
  WITH RECURSIVE batch(id, title, original) AS MATERIALIZED (${titles}),
  tails(id, tail) AS (
    SELECT id, title FROM batch
    UNION ALL SELECT id, original FROM batch WHERE title <> original
    UNION ALL SELECT id, substr(tail, 2) FROM tails
      WHERE length(tail) > 2 AND tail GLOB '*[^ -~]*'
  ), pairs(id, pair) AS (
    SELECT id, substr(tail, 1, 2) FROM tails WHERE length(tail) >= 2
  )
  SELECT id, group_concat(hex(pair), ' ') FROM pairs
  WHERE pair GLOB '*[^ -~]*' GROUP BY id`;

const closeConnection = (database: sqlite3.Database): Promise<void> =>
  new Promise((resolve, reject) =>
    database.close((error) => (error ? reject(error) : resolve()))
  );

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

// Short unaccented queries need alternate trigrams because the existing FTS
// index retains accents. Expand a bounded number of single-letter variants;
// this works with the current on-disk index and requires no reimport.
const accentTrigrams = (query: string, grams: string[]): string[] => {
  if (!/^[a-z]{3,8}$/.test(query)) return grams;
  const accents: Record<string, string> = {
    a: 'áàâäãå',
    c: 'ç',
    e: 'éèêë',
    i: 'íìîï',
    n: 'ñ',
    o: 'óòôöõ',
    u: 'úùûü',
    y: 'ýÿ',
  };
  const expanded = new Set(grams);
  for (const gram of grams) {
    for (let i = 0; i < gram.length; i++) {
      for (const variant of accents[gram[i]] ?? '') {
        expanded.add(gram.slice(0, i) + variant + gram.slice(i + 1));
        if (expanded.size >= 96) return [...expanded];
      }
    }
  }
  return [...expanded];
};

/** A disposable, independently rebuildable search index. */
export class SearchIndex {
  private database: sqlite3.Database;
  private reader?: sqlite3.Database;
  private titlePairsReady = false;
  private titlePairsBuild?: Promise<void>;
  private closing = false;
  private importing?: IndexSource;
  private revision = 0;
  private readonly searchCache = new Map<string, TitleMatch[]>();
  private readonly pendingSearches = new Map<string, Promise<TitleMatch[]>>();

  constructor(private readonly filename: string) {
    if (!filename || filename === ':memory:') {
      throw new Error('Search index requires a file-backed database');
    }
    this.database = new sqlite3.Database(filename);
  }

  private run(
    sql: string,
    params: (string | number | null)[] = [],
    database = this.database
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      database.run(sql, params, function (error) {
        if (error) reject(error);
        else resolve(this.changes);
      });
    });
  }

  private connect(mode: number): Promise<sqlite3.Database> {
    return new Promise((resolve, reject) => {
      const connection: sqlite3.Database = new sqlite3.Database(
        this.filename,
        mode,
        (error) => (error ? reject(error) : resolve(connection))
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
    // Keep short non-ASCII substring lookups on a narrow, covering SQLite
    // index. SQLite creates it from existing rows and maintains it on writes.
    await this.run(
      `CREATE INDEX IF NOT EXISTS title_non_ascii ON titles(id, searchTitle, searchOriginalTitle)
      WHERE ${NON_ASCII_TITLES}`
    );
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
    // Read the last committed WAL snapshot while an import is published.
    this.reader = await this.connect(sqlite3.OPEN_READONLY);
    await this.run(
      `PRAGMA mmap_size=${READ_MMAP_BYTES}`,
      [],
      this.reader
    ).catch(() => undefined);
    this.titlePairsBuild = this.backfillTitlePairs().catch((error) => {
      logger.warn('Short title pair index unavailable', {
        label: 'Search',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async backfillTitlePairs(): Promise<void> {
    // Use a separate writer so backfill statements cannot become part of an
    // import's transaction. Readers continue serving the committed index.
    const writer = await this.connect(sqlite3.OPEN_READWRITE);
    writer.configure('busyTimeout', 250);
    try {
      const newTokens = pairTokens(
        'SELECT new.id, new.searchTitle, new.searchOriginalTitle'
      );
      let installed = false;
      while (!this.closing && !this.titlePairsReady) {
        try {
          await this.run('BEGIN IMMEDIATE', [], writer);
        } catch (error) {
          if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error;
          await delay(50);
          continue;
        }
        try {
          if (!installed) {
            await this.run(
              `CREATE VIRTUAL TABLE IF NOT EXISTS title_pairs USING fts5(
                pairs, content='', contentless_delete=1, detail=none, tokenize='ascii'
              )`,
              [],
              writer
            );
            await this.run(
              `CREATE TRIGGER IF NOT EXISTS title_pairs_insert AFTER INSERT ON titles
                WHEN ${nonAsciiTitles('new.')} BEGIN
                INSERT INTO title_pairs(rowid, pairs) SELECT * FROM (${newTokens});
              END`,
              [],
              writer
            );
            await this.run(
              `CREATE TRIGGER IF NOT EXISTS title_pairs_update
                AFTER UPDATE OF id, searchTitle, searchOriginalTitle ON titles
                WHEN (${nonAsciiTitles('old.')} OR ${nonAsciiTitles('new.')})
                  AND (old.id <> new.id OR old.searchTitle <> new.searchTitle
                    OR old.searchOriginalTitle <> new.searchOriginalTitle) BEGIN
                DELETE FROM title_pairs WHERE rowid = old.id;
                INSERT INTO title_pairs(rowid, pairs) SELECT * FROM (${newTokens});
              END`,
              [],
              writer
            );
            await this.run(
              `CREATE TRIGGER IF NOT EXISTS title_pairs_delete AFTER DELETE ON titles
                WHEN ${nonAsciiTitles('old.')} BEGIN
                DELETE FROM title_pairs WHERE rowid = old.id;
              END`,
              [],
              writer
            );
            await this.run(
              `CREATE TABLE IF NOT EXISTS title_pairs_progress (
                id INTEGER PRIMARY KEY CHECK (id = 1), cursor INTEGER NOT NULL,
                complete INTEGER NOT NULL
              )`,
              [],
              writer
            );
          }
          const [progress] = await this.all<{
            cursor: number;
            complete: number;
          }>('SELECT cursor, complete FROM title_pairs_progress', [], writer);
          const cursor = progress?.cursor ?? 0;
          let complete = !!progress?.complete;
          if (!complete) {
            const [{ id }] = await this.all<{ id: number | null }>(
              `SELECT MAX(id) AS id FROM (
                SELECT id FROM titles INDEXED BY title_non_ascii
                WHERE id > ? AND ${NON_ASCII_TITLES} ORDER BY id LIMIT ${PAIR_BATCH_SIZE}
              )`,
              [cursor],
              writer
            );
            complete = id === null;
            if (id !== null)
              await this.run(
                `INSERT OR REPLACE INTO title_pairs(rowid, pairs) ${pairTokens(
                  `SELECT id, searchTitle, searchOriginalTitle
                  FROM titles INDEXED BY title_non_ascii
                  WHERE id > ? AND id <= ? AND ${NON_ASCII_TITLES}`
                )}`,
                [cursor, id],
                writer
              );
            await this.run(
              'INSERT OR REPLACE INTO title_pairs_progress VALUES (1, ?, ?)',
              [id ?? cursor, Number(complete)],
              writer
            );
          }
          await this.run('COMMIT', [], writer);
          installed = true;
          this.titlePairsReady = complete;
        } catch (error) {
          await this.run('ROLLBACK', [], writer).catch(() => undefined);
          throw error;
        }
        if (!this.titlePairsReady) await delay(10);
      }
    } finally {
      await closeConnection(writer);
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
    for (
      let offset = 0;
      offset < titles.length;
      offset += titleImportBatchSize
    ) {
      const batch = titles.slice(offset, offset + titleImportBatchSize);
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
    await this.publishImport(source, version, async () => {
      const [previous] = await this.all<{ count: number }>(
        'SELECT count(*) AS count FROM titles WHERE source = ?',
        [source]
      );
      if (previous.count > 1000 && count < previous.count * 0.5) {
        throw new Error(
          'Refusing to replace the search index with an incomplete import'
        );
      }
      const changed = await this.run(
        `INSERT INTO titles (source, sourceId, mediaType, title, originalTitle, searchTitle, searchOriginalTitle, popularity)
        SELECT ?, sourceId, mediaType, title, originalTitle, searchTitle, searchOriginalTitle, popularity FROM incoming_titles WHERE 1
        ON CONFLICT(source, sourceId) DO UPDATE SET
          mediaType=excluded.mediaType, title=excluded.title, originalTitle=excluded.originalTitle,
          searchTitle=excluded.searchTitle, searchOriginalTitle=excluded.searchOriginalTitle
        WHERE titles.mediaType != excluded.mediaType OR titles.title != excluded.title OR titles.originalTitle != excluded.originalTitle
          OR titles.searchTitle != excluded.searchTitle OR titles.searchOriginalTitle != excluded.searchOriginalTitle`,
        [source]
      );
      // The first import inserts the final popularity and has no rows to remove.
      if (!previous.count) return changed;

      // Keep vote changes out of the update that maintains the text indexes.
      const popularity = await this.run(
        `UPDATE titles SET popularity = incoming.popularity
        FROM incoming_titles AS incoming
        WHERE titles.source = ? AND titles.sourceId = incoming.sourceId AND titles.popularity != incoming.popularity`,
        [source]
      );
      const removed = await this.run(
        'DELETE FROM titles WHERE source = ? AND NOT EXISTS (SELECT 1 FROM incoming_titles WHERE incoming_titles.sourceId = titles.sourceId)',
        [source]
      );
      return changed + popularity + removed;
    });
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
    for (let offset = 0; offset < ratings.length; offset += 1000) {
      const batch = ratings.slice(offset, offset + 1000);
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
    await this.publishImport('imdb-ratings', version, async () => {
      const [previous] = await this.all<{ count: number }>(
        'SELECT count(*) AS count FROM imdb_votes'
      );
      if (previous.count > 1000 && count < previous.count * 0.5)
        throw new Error(
          'Refusing to replace IMDb ratings with an incomplete import'
        );
      const changed = await this.run(`INSERT INTO imdb_votes(sourceId, votes)
        SELECT sourceId, votes FROM incoming_votes WHERE 1
        ON CONFLICT(sourceId) DO UPDATE SET votes = excluded.votes
        WHERE imdb_votes.votes != excluded.votes`);
      if (!previous.count) return changed;
      const removed = await this.run(
        'DELETE FROM imdb_votes WHERE NOT EXISTS (SELECT 1 FROM incoming_votes WHERE incoming_votes.sourceId = imdb_votes.sourceId)'
      );
      return changed + removed;
    });
  }

  private async publishImport(
    source: IndexSource | 'imdb-ratings',
    version: string,
    update: () => Promise<number>
  ): Promise<void> {
    await this.run('BEGIN IMMEDIATE');
    try {
      const changed = await update();
      await this.run(
        `INSERT INTO index_metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        WHERE index_metadata.value != excluded.value`,
        [source, version]
      );
      await this.run('COMMIT');
      if (changed) {
        this.revision++;
        this.searchCache.clear();
      }
      this.importing = undefined;
    } catch (error) {
      await this.run('ROLLBACK').catch(() => undefined);
      throw error;
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
    if (!this.reader) throw new Error('Search index is not initialized');
    const normalized = normalizeTitle(query);
    const characters = Array.from(normalized);
    const shortNonLatin =
      characters.length >= 2 &&
      characters.length <= 4 &&
      !normalized.includes(' ') &&
      /[^\p{ASCII}]/u.test(normalized);
    const grams = accentTrigrams(normalized, trigrams(normalized));
    if (!grams.length && !shortNonLatin) return [];
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
      pending = this.findMatches(normalized, grams, limit, shortNonLatin);
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
    limit: number,
    shortNonLatin: boolean
  ): Promise<TitleMatch[]> {
    const expression = grams
      .map((gram) => `"${gram.replace(/"/g, '""')}"`)
      .join(' OR ');
    const select = `SELECT t.source, t.sourceId, t.mediaType, t.title, t.originalTitle, t.searchTitle, t.searchOriginalTitle, CASE WHEN t.source = 'imdb' THEN COALESCE(v.votes, 0) ELSE t.popularity END AS popularity
      FROM titles t LEFT JOIN imdb_votes v ON t.source = 'imdb' AND t.sourceId = v.sourceId`;
    const candidates = grams.length
      ? await this.all<CandidateRow>(
          // Let SQLite limit its BM25 sort before reading titles and votes.
          `WITH matches AS MATERIALIZED (
            SELECT rowid AS id, bm25(title_fts) AS score FROM title_fts
            WHERE title_fts MATCH ? ORDER BY score, rowid LIMIT 5000
          )
          SELECT t.source, t.sourceId, t.mediaType, t.title, t.originalTitle,
            t.searchTitle, t.searchOriginalTitle,
            CASE WHEN t.source = 'imdb' THEN COALESCE(v.votes, 0) ELSE t.popularity END AS popularity
          FROM matches m CROSS JOIN titles t ON t.id = m.id
          LEFT JOIN imdb_votes v ON t.source = 'imdb' AND t.sourceId = v.sourceId
          ORDER BY m.score, m.id`,
          [expression],
          this.reader
        )
      : [];
    // A changed character can remove every trigram from a short title. Other
    // titles can still match the query's trigrams, so supplement those matches
    // with adjacent pairs rather than only falling back on an empty result.
    if (shortNonLatin) {
      const chars = Array.from(normalized);
      const pairs = [
        ...new Set(
          chars.slice(0, -1).map((_, i) => chars.slice(i, i + 2).join(''))
        ),
      ];
      // Every hit must contain non-ASCII if each pair does. Mixed-script
      // queries may have an ASCII pair, so they still scan the full table.
      const useCoveringIndex = pairs.every((pair) =>
        /[^\p{ASCII}]/u.test(pair)
      );
      let nearby: CandidateRow[] | undefined;
      if (useCoveringIndex && this.titlePairsReady) {
        nearby = await this.all<CandidateRow>(
          `WITH nearby AS MATERIALIZED (
            SELECT rowid AS id FROM title_pairs WHERE title_pairs MATCH ?
            ORDER BY rowid LIMIT 5000
          ) ${select} JOIN nearby ON nearby.id = t.id ORDER BY t.id`,
          [pairs.map((pair) => Buffer.from(pair).toString('hex')).join(' OR ')],
          this.reader
        ).catch(() => {
          this.titlePairsReady = false;
          return undefined;
        });
      }
      if (!nearby) {
        const predicates = pairs.map(
          () => '(instr(searchTitle, ?) OR instr(searchOriginalTitle, ?))'
        );
        nearby = await this.all<CandidateRow>(
          `WITH nearby AS MATERIALIZED (
            SELECT id FROM titles ${useCoveringIndex ? 'INDEXED BY title_non_ascii' : ''}
            WHERE ${useCoveringIndex ? `${NON_ASCII_TITLES} AND ` : ''}(${predicates.join(' OR ')})
            ORDER BY id LIMIT 5000
          ) ${select} JOIN nearby ON nearby.id = t.id ORDER BY t.id`,
          pairs.flatMap((pair) => [pair, pair]),
          this.reader
        );
      }
      const keys = new Set(
        candidates.map(
          (item) => `${item.source}:${item.mediaType}:${item.sourceId}`
        )
      );
      candidates.push(
        ...nearby.filter(
          (item) =>
            !keys.has(`${item.source}:${item.mediaType}:${item.sourceId}`)
        )
      );
    }
    const similarity = prepareTitleSimilarity(normalized);
    return candidates
      .map(({ searchTitle, searchOriginalTitle, ...candidate }) => {
        const titleScore = similarity(searchTitle);
        const score =
          searchOriginalTitle === searchTitle
            ? titleScore
            : Math.max(titleScore, similarity(searchOriginalTitle));
        return {
          match: { ...candidate, score },
          rank: titleRank(score, candidate.popularity),
        };
      })
      .filter(({ match }) => match.score >= (shortNonLatin ? 0.75 : 0.78))
      .sort(
        (a, b) =>
          b.rank - a.rank || a.match.sourceId.localeCompare(b.match.sourceId)
      )
      .slice(0, limit)
      .map(({ match }) => match);
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.titlePairsBuild;
    const databases = this.reader
      ? [this.reader, this.database]
      : [this.database];
    await Promise.all(databases.map(closeConnection));
  }
}
