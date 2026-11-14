import { createHash, randomUUID } from 'crypto';
import sqlite3 from 'sqlite3';
import type { SmartDocument, SmartFilters, SmartMediaType } from './types';
import { prepareCosine } from './vectors';

export interface SmartMatch {
  document: SmartDocument;
  score: number;
  reranked?: boolean;
  relevanceScore?: number;
  methods?: (
    | 'semantic'
    | 'lexical'
    | 'tmdb-keyword'
    | 'tmdb-similar'
    | 'tmdb-recommendation'
  )[];
}
export const documentText = (document: SmartDocument): string => {
  const genres: Record<number, string> = {
    28: 'action',
    12: 'adventure',
    16: 'animation',
    35: 'comedy',
    80: 'crime',
    99: 'documentary',
    18: 'drama',
    10751: 'family',
    14: 'fantasy',
    36: 'history',
    27: 'horror',
    10402: 'music',
    9648: 'mystery',
    10749: 'romance',
    878: 'science fiction',
    10770: 'television movie',
    53: 'thriller',
    10752: 'war',
    37: 'western',
    10759: 'action adventure',
    10762: 'children',
    10763: 'news',
    10764: 'reality',
    10765: 'science fiction fantasy',
    10766: 'soap opera',
    10767: 'talk show',
    10768: 'war politics',
  };
  const labels = document.genreIds
    .map((id) => genres[id])
    .filter(Boolean)
    .join(', ');
  return Array.from(
    `${labels ? `Genres: ${labels}. ` : ''}${document.overview}`
      .replace(/\s+/gu, ' ')
      .trim()
  )
    .slice(0, 450)
    .join('');
};
export const documentHash = (document: SmartDocument): string =>
  createHash('sha256').update(documentText(document)).digest('hex');

type Row = {
  id: number;
  vector: Buffer;
  document: string;
  hash: string;
  voteCount: number;
};
export class SmartStore {
  private db: sqlite3.Database;
  private lexicalTask?: Promise<void>;
  private lexicalPaused = false;
  private lexicalComplete = false;
  private closing = false;
  private lexicalCount = 0;
  private lexicalTotal = 0;
  private lexicalError?: string;
  private readonly activeSearches = new Set<Promise<void>>();
  private readonly documentVersionId = randomUUID();
  private documentRevision = 0;
  private activeDocumentWrites = 0;
  constructor(private readonly filename: string) {
    this.db = new sqlite3.Database(filename);
  }
  private run(
    sql: string,
    params: (string | number | Buffer | null)[] = [],
    db = this.db
  ): Promise<void> {
    return new Promise((resolve, reject) =>
      db.run(sql, params, (error) => (error ? reject(error) : resolve()))
    );
  }
  private all<T>(
    sql: string,
    params: (string | number)[] = [],
    db = this.db
  ): Promise<T[]> {
    return new Promise((resolve, reject) =>
      db.all<T>(sql, params, (error, rows) =>
        error ? reject(error) : resolve(rows)
      )
    );
  }
  async initialize(): Promise<void> {
    await this.run('PRAGMA journal_mode=WAL');
    await this.run(`CREATE TABLE IF NOT EXISTS smart_documents (
      id INTEGER PRIMARY KEY, source TEXT NOT NULL, sourceId TEXT NOT NULL, mediaType TEXT NOT NULL,
      language TEXT NOT NULL, year INTEGER, voteAverage REAL NOT NULL, voteCount INTEGER NOT NULL,
      genres TEXT NOT NULL, hash TEXT NOT NULL, vector BLOB NOT NULL, document TEXT NOT NULL,
      UNIQUE(source, sourceId, mediaType))`);
    await this.run(
      'CREATE INDEX IF NOT EXISTS smart_filters ON smart_documents(mediaType, language, year)'
    );
    await this.run(
      'CREATE TABLE IF NOT EXISTS smart_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
    );
    await this.run(
      `CREATE VIRTUAL TABLE IF NOT EXISTS smart_fts USING fts5(title, overview, tokenize='unicode61 remove_diacritics 2')`
    );
    await this
      .run(`CREATE TRIGGER IF NOT EXISTS smart_fts_insert AFTER INSERT ON smart_documents BEGIN
      INSERT OR REPLACE INTO smart_fts(rowid, title, overview) VALUES (new.id, json_extract(new.document, '$.title'), json_extract(new.document, '$.overview'));
    END`);
    await this
      .run(`CREATE TRIGGER IF NOT EXISTS smart_fts_update AFTER UPDATE ON smart_documents BEGIN
      DELETE FROM smart_fts WHERE rowid = old.id;
      INSERT OR REPLACE INTO smart_fts(rowid, title, overview) VALUES (new.id, json_extract(new.document, '$.title'), json_extract(new.document, '$.overview'));
    END`);
    await this
      .run(`CREATE TRIGGER IF NOT EXISTS smart_fts_delete AFTER DELETE ON smart_documents BEGIN
      DELETE FROM smart_fts WHERE rowid = old.id;
    END`);
    this.lexicalCount = (
      await this.all<{ n: number }>('SELECT count(*) AS n FROM smart_fts')
    )[0].n;
    this.lexicalTotal = await this.count();
    this.resumeLexical();
  }

  pauseLexical(): void {
    this.lexicalPaused = true;
  }

  resumeLexical(): void {
    this.lexicalPaused = false;
    if (this.closing || this.lexicalTask || this.lexicalComplete) return;
    this.lexicalError = undefined;
    this.lexicalTask = this.backfillLexical()
      .catch((error) => {
        this.lexicalError =
          error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.lexicalTask = undefined;
        if (
          !this.lexicalPaused &&
          !this.closing &&
          !this.lexicalComplete &&
          !this.lexicalError
        )
          this.resumeLexical();
      });
  }

  lexicalStatus() {
    return {
      indexed: this.lexicalCount,
      total: Math.max(this.lexicalCount, this.lexicalTotal),
      indexing: !!this.lexicalTask && !this.lexicalPaused,
      complete: this.lexicalComplete,
      error: this.lexicalError,
    };
  }

  private async backfillLexical(): Promise<void> {
    let cursor = Number((await this.getState('lexicalCursor')) || 0);
    let reachedEnd = false;
    while (!this.closing && !this.lexicalPaused) {
      const rows = await this.all<{ id: number }>(
        'SELECT id FROM smart_documents WHERE id > ? ORDER BY id LIMIT 512',
        [cursor]
      );
      if (!rows.length) {
        reachedEnd = true;
        break;
      }
      const last = rows[rows.length - 1].id;
      await this.run(
        `INSERT OR REPLACE INTO smart_fts(rowid, title, overview)
        SELECT id, json_extract(document, '$.title'), json_extract(document, '$.overview')
        FROM smart_documents WHERE id > ? AND id <= ?`,
        [cursor, last]
      );
      cursor = last;
      await this.setState('lexicalCursor', String(cursor));
      if (cursor % 8192 < 512)
        this.lexicalCount = (
          await this.all<{ n: number }>('SELECT count(*) AS n FROM smart_fts')
        )[0].n;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.lexicalCount = (
      await this.all<{ n: number }>('SELECT count(*) AS n FROM smart_fts')
    )[0].n;
    this.lexicalTotal = await this.count();
    this.lexicalComplete = reachedEnd;
  }

  async searchLexical(
    query: string,
    filters: SmartFilters = {},
    limit = 60
  ): Promise<SmartMatch[]> {
    const stopwords = new Set([
      'the',
      'and',
      'for',
      'with',
      'from',
      'into',
      'about',
      'this',
      'that',
      'their',
      'have',
      'who',
      'are',
      'was',
      'were',
      'where',
      'when',
      'what',
      'film',
      'movie',
      'movies',
      'show',
      'shows',
      'series',
    ]);
    const words = [
      ...new Set(
        (query.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).filter(
          (word) => {
            if (/^[a-z0-9]+$/u.test(word))
              return word.length >= 3 && !stopwords.has(word);
            return Array.from(word).length >= 2;
          }
        )
      ),
    ].slice(0, 8);
    if (!words.length) return [];
    // Plot search uses whole terms; title typo/substring matching has its own
    // index. Prefix expansion of common words can stall SQLite for minutes.
    const expression = words
      .map((word) => `"${word.replace(/"/g, '""')}"`)
      .join(' OR ');
    const conditions = [
      'smart_fts MATCH ?',
      "smart_fts.rank MATCH 'bm25(3.0, 1.0)'",
    ];
    const params: (string | number)[] = [expression];
    if (filters.mediaType) {
      conditions.push('d.mediaType = ?');
      params.push(filters.mediaType);
    }
    if (filters.language) {
      conditions.push('d.language = ?');
      params.push(filters.language);
    }
    if (filters.yearFrom !== undefined) {
      conditions.push('d.year >= ?');
      params.push(filters.yearFrom);
    }
    if (filters.yearTo !== undefined) {
      conditions.push('d.year <= ?');
      params.push(filters.yearTo);
    }
    if (filters.minRating !== undefined) {
      conditions.push('d.voteAverage >= ?');
      params.push(filters.minRating);
    }
    if (filters.minVotes !== undefined) {
      conditions.push('d.voteCount >= ?');
      params.push(filters.minVotes);
    }
    if (filters.genre !== undefined) {
      conditions.push(
        'EXISTS (SELECT 1 FROM json_each(d.genres) WHERE value = ?)'
      );
      params.push(filters.genre);
    }
    params.push(limit);
    const rows = await this.all<{ document: string; rank: number }>(
      `SELECT d.document, smart_fts.rank AS rank
      FROM smart_fts CROSS JOIN smart_documents d ON d.id=smart_fts.rowid WHERE ${conditions.join(' AND ')} ORDER BY smart_fts.rank LIMIT ?`,
      params
    );
    const fold = (value: string) =>
      value
        .toLowerCase()
        .normalize('NFD')
        .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
        .normalize('NFC');
    const terms = words.map(fold);
    const minimum = words.length >= 4 ? Math.ceil(words.length / 3) : 1;
    return rows
      .map((row) => ({
        document: JSON.parse(row.document) as SmartDocument,
        score: -row.rank,
        methods: ['lexical'] as SmartMatch['methods'],
      }))
      .filter(({ document }) => {
        const text = fold(`${document.title} ${document.overview}`);
        return terms.filter((word) => text.includes(word)).length >= minimum;
      });
  }
  async getState(key: string): Promise<string | undefined> {
    return (
      await this.all<{ value: string }>(
        'SELECT value FROM smart_state WHERE key = ?',
        [key]
      )
    )[0]?.value;
  }
  async setState(key: string, value: string): Promise<void> {
    await this.run('INSERT OR REPLACE INTO smart_state VALUES (?, ?)', [
      key,
      value,
    ]);
  }

  /**
   * Opaque cache token for document contents and vectors. A local write that
   * is in flight (or overlaps the PRAGMA) makes the version unavailable.
   * SQLite's data_version observes commits on other connections; our local
   * revision covers this connection, whose own commits do not change it.
   */
  async documentVersion(): Promise<string | undefined> {
    if (this.closing) throw new Error('Search index is closing');
    if (this.activeDocumentWrites) return undefined;
    const revision = this.documentRevision;
    const rows = await this.all<{ data_version: number }>(
      'PRAGMA data_version'
    );
    if (this.closing) throw new Error('Search index is closing');
    if (this.activeDocumentWrites || revision !== this.documentRevision)
      return undefined;
    const externalVersion = rows[0]?.data_version;
    if (!Number.isSafeInteger(externalVersion))
      throw new Error('Unable to read search index version');
    return `${this.documentVersionId}:${revision}:${externalVersion}`;
  }

  private async writeDocuments(write: () => Promise<void>): Promise<void> {
    this.activeDocumentWrites++;
    this.documentRevision++;
    try {
      await write();
    } finally {
      // Advance even on failure: callers cannot assume a failed write had no
      // observable effects, and overlapping writes remain unavailable.
      this.documentRevision++;
      this.activeDocumentWrites--;
    }
  }
  async existing(
    source: string,
    type: SmartMediaType,
    ids: string[]
  ): Promise<Map<string, { hash: string; vector: Buffer }>> {
    if (!ids.length) return new Map();
    const rows = await this.all<{
      sourceId: string;
      hash: string;
      vector: Buffer;
    }>(
      `SELECT sourceId, hash, vector FROM smart_documents WHERE source = ? AND mediaType = ? AND sourceId IN (${ids.map(() => '?').join(',')})`,
      [source, type, ...ids]
    );
    return new Map(
      rows.map((row) => [row.sourceId, { hash: row.hash, vector: row.vector }])
    );
  }
  async upsert(document: SmartDocument, vector: Buffer): Promise<void> {
    return this.upsertBatch([{ document, vector }]);
  }
  async upsertBatch(
    items: { document: SmartDocument; vector: Buffer }[]
  ): Promise<void> {
    if (!items.length) return;
    const values = items
      .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .join(',');
    const params = items.flatMap(({ document, vector }) => [
      document.source,
      document.sourceId,
      document.mediaType,
      document.originalLanguage,
      document.year,
      document.voteAverage,
      document.voteCount,
      JSON.stringify(document.genreIds),
      documentHash(document),
      vector,
      JSON.stringify(document),
    ]);
    await this.writeDocuments(() =>
      this.run(
        `INSERT INTO smart_documents(source, sourceId, mediaType, language, year, voteAverage, voteCount, genres, hash, vector, document) VALUES ${values}
      ON CONFLICT(source, sourceId, mediaType) DO UPDATE SET language=excluded.language, year=excluded.year, voteAverage=excluded.voteAverage, voteCount=excluded.voteCount, genres=excluded.genres, hash=excluded.hash, vector=excluded.vector, document=excluded.document
      WHERE smart_documents.hash != excluded.hash OR smart_documents.document != excluded.document`,
        params
      )
    );
  }
  async remove(
    source: string,
    type: SmartMediaType,
    id: string
  ): Promise<void> {
    await this.writeDocuments(() =>
      this.run(
        'DELETE FROM smart_documents WHERE source = ? AND mediaType = ? AND sourceId = ?',
        [source, type, id]
      )
    );
  }
  async count(): Promise<number> {
    return (
      await this.all<{ n: number }>('SELECT count(*) AS n FROM smart_documents')
    )[0].n;
  }
  async find(
    source: string,
    type: SmartMediaType,
    id: string
  ): Promise<{ document: SmartDocument; vector: Buffer } | undefined> {
    const row = (
      await this.all<Row>(
        'SELECT id, document, vector, hash FROM smart_documents WHERE source=? AND mediaType=? AND sourceId=?',
        [source, type, id]
      )
    )[0];
    return (
      row && {
        document: JSON.parse(row.document) as SmartDocument,
        vector: row.vector,
      }
    );
  }
  async search(
    vector: Buffer,
    filters: SmartFilters = {},
    limit = 30
  ): Promise<SmartMatch[]> {
    if (this.closing) throw new Error('Search index is closing');
    if (limit <= 0) return [];
    // The writer continues indexing on the main connection. A separate,
    // read-only transaction keeps the vector and final document in the same
    // snapshot even when a title is updated or removed during the scan.
    // In-memory and temporary databases cannot be reopened by filename. Keep
    // their original single-connection scan and capture documents as we go.
    const transient =
      this.filename === ':memory:' ||
      this.filename === '' ||
      this.filename.startsWith('file::memory:') ||
      /[?&]mode=memory(?:&|$)/u.test(this.filename);
    let finish: () => void = () => undefined;
    const active = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.activeSearches.add(active);
    let snapshot: sqlite3.Database | undefined;
    try {
      snapshot = transient
        ? this.db
        : await new Promise<sqlite3.Database>((resolve, reject) => {
            const connection: sqlite3.Database = new sqlite3.Database(
              this.filename,
              sqlite3.OPEN_READONLY,
              (error) => (error ? reject(error) : resolve(connection))
            );
          });
      if (!transient) await this.run('BEGIN', [], snapshot);
      const conditions = ['id > ?'];
      const params: (string | number)[] = [];
      if (filters.mediaType) {
        conditions.push('mediaType = ?');
        params.push(filters.mediaType);
      }
      if (filters.language) {
        conditions.push('language = ?');
        params.push(filters.language);
      }
      if (filters.yearFrom !== undefined) {
        conditions.push('year >= ?');
        params.push(filters.yearFrom);
      }
      if (filters.yearTo !== undefined) {
        conditions.push('year <= ?');
        params.push(filters.yearTo);
      }
      if (filters.minRating !== undefined) {
        conditions.push('voteAverage >= ?');
        params.push(filters.minRating);
      }
      if (filters.minVotes !== undefined) {
        conditions.push('voteCount >= ?');
        params.push(filters.minVotes);
      }
      if (filters.genre !== undefined) {
        conditions.push(
          'EXISTS (SELECT 1 FROM json_each(genres) WHERE value = ?)'
        );
        params.push(filters.genre);
      }
      let after = 0;
      const scoreVector = prepareCosine(vector);
      const best: {
        id: number;
        score: number;
        rank: number;
        document?: string;
      }[] = [];
      for (;;) {
        const rows = await this.all<
          Pick<Row, 'id' | 'vector' | 'voteCount'> & { document?: string }
        >(
          `SELECT id, vector, voteCount${transient ? ', document' : ''} FROM smart_documents NOT INDEXED WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT 512`,
          [after, ...params],
          snapshot
        );
        if (!rows.length) break;
        for (const row of rows) {
          const score = scoreVector(row.vector);
          // A small, capped audience-evidence bonus breaks close semantic ties
          // without removing unrated or less well-known titles.
          const rank =
            score +
            0.015 *
              Math.min(
                1,
                Math.log1p(Math.max(0, row.voteCount)) / Math.log(1001)
              );
          if (best.length < limit || rank > best[best.length - 1].rank) {
            best.push({
              id: row.id,
              score,
              rank,
              document: row.document,
            });
            best.sort((a, b) => b.rank - a.rank);
            if (best.length > limit) best.pop();
          }
        }
        after = rows[rows.length - 1].id;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      // Fetch descriptions only for the final shortlist; reading each large JSON
      // document during the vector scan adds substantial SQLite and Node work.
      if (transient)
        return best.map(({ document, score }) => ({
          document: JSON.parse(document!) as SmartDocument,
          score,
        }));
      const documents = new Map<number, SmartDocument>();
      for (let start = 0; start < best.length; start += 500) {
        const ids = best.slice(start, start + 500).map((item) => item.id);
        const rows = await this.all<Pick<Row, 'id' | 'document'>>(
          `SELECT id, document FROM smart_documents WHERE id IN (${ids.map(() => '?').join(',')})`,
          ids,
          snapshot
        );
        rows.forEach((row) => documents.set(row.id, JSON.parse(row.document)));
      }
      return best.flatMap(({ id, score }) => {
        const document = documents.get(id);
        return document ? [{ document, score }] : [];
      });
    } finally {
      try {
        if (!transient && snapshot)
          await new Promise<void>((resolve, reject) =>
            snapshot!.close((error) => (error ? reject(error) : resolve()))
          );
      } finally {
        this.activeSearches.delete(active);
        finish();
      }
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.lexicalTask;
    await Promise.all(this.activeSearches);
    await new Promise<void>((resolve, reject) =>
      this.db.close((error) => (error ? reject(error) : resolve()))
    );
  }
}
