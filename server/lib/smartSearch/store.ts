import { createHash, randomUUID } from 'crypto';
import { LRUCache } from 'lru-cache';
import { endianness } from 'node:os';
import sqlite3 from 'sqlite3';
import {
  smartMediaTypes,
  type SmartDocument,
  type SmartFilters,
  type SmartMediaType,
} from './types';
import { prepareCosine } from './vectors';

export interface SmartMatch {
  document: SmartDocument;
  score: number;
  reranked?: boolean;
  relevanceScore?: number;
  seedTitle?: string;
  sharedGenreIds?: number[];
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
const denseVoteBonuses = Array.from(
  { length: 1001 },
  (_, votes) => 0.015 * (Math.log1p(votes) / Math.log(1001))
);

const nativeVoteBonuses = Buffer.from(
  Float64Array.from(denseVoteBonuses).buffer
);
const littleEndian = endianness() === 'LE';

type DenseHit = { id: number; score: number; document?: string };
type NeighborPool = {
  revision: number;
  hits: DenseHit[];
  matches: SmartMatch[];
  exhaustive: boolean;
};
const neighborReserve = 24;
const neighborChangeRetention = 8192;
const maxNeighborDelta = 4096;
const minKeywordEnrichmentVotes = 100;
const maxKeywords = 64;
const maxKeywordLength = 120;
const readMmapBytes = 0x7fff0000;
const plotStopwords = new Set([
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
const wordsIn = (text: string): string[] =>
  text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
export const plotSearchWords = (query: string): string[] =>
  [
    ...new Set(
      wordsIn(query).filter((word) =>
        /^[a-z0-9]+$/u.test(word)
          ? word.length >= 3 && !plotStopwords.has(word)
          : Array.from(word).length >= 2
      )
    ),
  ].slice(0, 8);
export const foldText = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC');
const keywordPrefix = (word: string): boolean => /^[a-z]{5,}$/u.test(word);
const ftsTerms = (words: readonly string[], allowPrefixes = false): string =>
  words
    .map(
      (word) =>
        `"${word.replace(/"/g, '""')}"${allowPrefixes && keywordPrefix(word) ? '*' : ''}`
    )
    .join(' OR ');

// Only explicit keyword arrays are published. An empty string is the
// coverage row for titles whose source returned no keywords.
const storedKeywords = (document: string): string =>
  `COALESCE((SELECT group_concat(substr(value, 1, ${maxKeywordLength}), char(10))
    FROM json_each(${document}, '$.keywords') WHERE type = 'text' AND key < ${maxKeywords}), '')`;

const metadataConditions = (filters: SmartFilters) => {
  const clauses = [];
  const values: (string | number)[] = [];
  if (filters.mediaType) {
    clauses.push('d.mediaType = ?');
    values.push(filters.mediaType);
  }
  if (filters.language) {
    clauses.push('d.language = ?');
    values.push(filters.language);
  }
  if (filters.yearFrom !== undefined) {
    clauses.push('d.year >= ?');
    values.push(filters.yearFrom);
  }
  if (filters.yearTo !== undefined) {
    clauses.push('d.year <= ?');
    values.push(filters.yearTo);
  }
  if (filters.minRating !== undefined) {
    clauses.push('d.voteAverage >= ?');
    values.push(filters.minRating);
  }
  if (filters.minVotes !== undefined) {
    clauses.push('d.voteCount >= ?');
    values.push(filters.minVotes);
  }
  if (filters.genre !== undefined) {
    clauses.push('EXISTS (SELECT 1 FROM json_each(d.genres) WHERE value = ?)');
    values.push(filters.genre);
  }
  return { clauses, values };
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
  private idleDenseReader?: sqlite3.Database;
  private readonly nativeReaders = new WeakSet<sqlite3.Database>();
  private readonly neighbors = new LRUCache<string, NeighborPool>({
    max: 48,
    maxSize: 4096,
    sizeCalculation: ({ hits }) => Math.max(1, hits.length),
  });
  private readonly documentVersionId = randomUUID();
  private documentRevision = 0;
  private activeDocumentWrites = 0;
  private canLoadVectorExtension = true;
  private vectorExtensionLoaded = false;
  private nativeVoteRanking?: boolean;
  private denseCoverAvailable = false;
  constructor(
    private readonly filename: string,
    private readonly vectorExtension = process.env.SEERR_VECTOR_EXTENSION
  ) {
    this.db = new sqlite3.Database(filename);
  }
  get vectorBackend() {
    return this.vectorExtensionLoaded && this.canLoadVectorExtension
      ? 'sqlite'
      : 'javascript';
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
    params: (string | number | Buffer)[] = [],
    db = this.db
  ): Promise<T[]> {
    return new Promise((resolve, reject) =>
      db.all<T>(sql, params, (error, rows) =>
        error ? reject(error) : resolve(rows)
      )
    );
  }

  private async read<T>(
    query: (connection: sqlite3.Database, transient: boolean) => Promise<T>,
    dense = false
  ): Promise<T> {
    if (this.closing) throw new Error('Search index is closing');
    // In-memory and temporary databases cannot be reopened by filename.
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
    let connection: sqlite3.Database | undefined;
    let began = false;
    let completed = false;
    try {
      if (transient) connection = this.db;
      else if (dense && this.idleDenseReader) {
        connection = this.idleDenseReader;
        this.idleDenseReader = undefined;
      } else {
        connection = await new Promise<sqlite3.Database>((resolve, reject) => {
          const reader: sqlite3.Database = new sqlite3.Database(
            this.filename,
            sqlite3.OPEN_READONLY,
            (error) => (error ? reject(error) : resolve(reader))
          );
        });
        // Use SQLite's standard mmap ceiling for demand-paged reads of
        // shortlisted documents. Other VFSes can fall back to cached I/O.
        await this.run(
          `PRAGMA mmap_size=${readMmapBytes}`,
          [],
          connection
        ).catch(() => undefined);
      }
      if (dense && !transient) {
        await this.run('BEGIN', [], connection);
        began = true;
      }
      const result = await query(connection, transient);
      completed = true;
      return result;
    } finally {
      try {
        if (!transient && connection) {
          const reset =
            began &&
            (await this.run('ROLLBACK', [], connection).then(
              () => true,
              () => false
            ));
          // A cleared snapshot can be lent to the next scan. Keep only one
          // idle handle and discard any connection that encountered an error.
          if (completed && reset && !this.closing && !this.idleDenseReader) {
            this.idleDenseReader = connection;
          } else await this.closeConnection(connection);
        }
      } finally {
        this.activeSearches.delete(active);
        finish();
      }
    }
  }

  private closeConnection(connection: sqlite3.Database): Promise<void> {
    return new Promise((resolve, reject) =>
      connection.close((error) => (error ? reject(error) : resolve()))
    );
  }

  private readSearchRows<T>(
    sql: string,
    params: (string | number)[],
    signal?: AbortSignal
  ): Promise<T[]> {
    return this.read(async (connection, transient) => {
      signal?.throwIfAborted();
      const interrupt = () => connection.interrupt();
      if (!transient)
        signal?.addEventListener('abort', interrupt, { once: true });
      try {
        return await this.all<T>(sql, params, connection);
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      } finally {
        if (!transient) signal?.removeEventListener('abort', interrupt);
      }
    });
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
      'CREATE INDEX IF NOT EXISTS smart_original_language ON smart_documents(language)'
    );
    if (this.vectorExtension) {
      // Bulk native scans read just these columns. Keep the original scan
      // path available if there is insufficient space for this extra index.
      this.denseCoverAvailable = await this.run(
        `CREATE INDEX IF NOT EXISTS smart_dense_cover ON smart_documents(
          mediaType, language, id, vector, voteCount, year, voteAverage, genres)`
      ).then(
        () => true,
        () => false
      );
    }
    await this.run(
      'CREATE TABLE IF NOT EXISTS smart_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
    );
    await this.run(
      'CREATE TABLE IF NOT EXISTS smart_neighbor_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER NOT NULL)'
    );
    for (const [action, row] of [
      ['INSERT', 'new'],
      ['UPDATE', 'new'],
      ['DELETE', 'old'],
    ]) {
      // The log starts empty on an existing index. Each mutation publishes
      // with the actual document, including on another SQLite connection.
      await this
        .run(`CREATE TRIGGER IF NOT EXISTS smart_neighbors_${action.toLowerCase()}
        AFTER ${action} ON smart_documents BEGIN
        ${action === 'UPDATE' ? 'INSERT INTO smart_neighbor_changes(id) SELECT old.id WHERE old.id != new.id;' : ''}
        INSERT INTO smart_neighbor_changes(id) VALUES (${row}.id);
        DELETE FROM smart_neighbor_changes
        WHERE seq <= last_insert_rowid() - ${neighborChangeRetention}
        AND last_insert_rowid() % 256 = 0;
        END`);
    }
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
    await this
      .run(`CREATE VIRTUAL TABLE IF NOT EXISTS smart_keywords USING fts5(
      keywords, detail=none, tokenize='porter unicode61 remove_diacritics 2'
    )`);
    await this.run(`CREATE INDEX IF NOT EXISTS smart_keyword_enrichment
      ON smart_documents(source, voteCount DESC, id)
      WHERE voteCount >= ${minKeywordEnrichmentVotes}`);
    await this.run(`CREATE TRIGGER IF NOT EXISTS smart_keywords_insert
      AFTER INSERT ON smart_documents
      WHEN json_type(new.document, '$.keywords') = 'array' BEGIN
      INSERT INTO smart_keywords(rowid, keywords)
      VALUES (new.id, ${storedKeywords('new.document')});
    END`);
    await this.run(`CREATE TRIGGER IF NOT EXISTS smart_keywords_update
      AFTER UPDATE OF id, document ON smart_documents
      WHEN old.id != new.id OR json_type(new.document, '$.keywords') = 'array' BEGIN
      DELETE FROM smart_keywords WHERE rowid = new.id;
      INSERT INTO smart_keywords(rowid, keywords)
      SELECT new.id, ${storedKeywords('new.document')}
      WHERE json_type(new.document, '$.keywords') = 'array'
      UNION ALL
      SELECT new.id, keywords FROM smart_keywords
      WHERE rowid = old.id AND json_type(new.document, '$.keywords') IS NOT 'array';
      DELETE FROM smart_keywords WHERE rowid = old.id AND old.id != new.id;
    END`);
    await this.run(`CREATE TRIGGER IF NOT EXISTS smart_keywords_delete
      AFTER DELETE ON smart_documents BEGIN
      DELETE FROM smart_keywords WHERE rowid = old.id;
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
    limit = 60,
    signal?: AbortSignal
  ): Promise<SmartMatch[]> {
    signal?.throwIfAborted();
    const words = plotSearchWords(query);
    if (!words.length) return [];
    // Plot search uses whole terms; title typo/substring matching has its own
    // index. Prefix expansion of common words can stall SQLite for minutes.
    const { clauses, values } = metadataConditions(filters);
    const match = "smart_fts MATCH ? AND smart_fts.rank MATCH 'bm25(3.0, 1.0)'";
    // With a meaningful vote floor, preselect the small eligible ID set
    // from the covering index. Broad FTS matches then avoid random lookups
    // into full document rows just to reject them on metadata.
    const useCover = this.denseCoverAvailable && (filters.minVotes ?? 0) >= 100;
    const expression = ftsTerms(words);
    // FTS ranking can be expensive for broad terms. Isolate it so it cannot
    // delay indexing or the dense search's document-version checks.
    const rows = await this.readSearchRows<{ document: string; rank: number }>(
      useCover
        ? `WITH allowed AS MATERIALIZED (
            SELECT d.id FROM smart_documents d INDEXED BY smart_dense_cover
            WHERE ${clauses.join(' AND ')}
          ), ranked AS MATERIALIZED (
            SELECT smart_fts.rowid AS id, smart_fts.rank AS rank
            FROM smart_fts CROSS JOIN allowed a ON a.id = smart_fts.rowid
            WHERE ${match} ORDER BY smart_fts.rank LIMIT ?
          )
          SELECT d.document, r.rank FROM ranked r
          CROSS JOIN smart_documents d ON d.id = r.id
          ORDER BY r.rank, r.id`
        : clauses.length
          ? `SELECT d.document, smart_fts.rank AS rank
          FROM smart_fts CROSS JOIN smart_documents d ON d.id=smart_fts.rowid
          WHERE ${[match, ...clauses].join(' AND ')} ORDER BY smart_fts.rank LIMIT ?`
          : `WITH ranked AS MATERIALIZED (
              SELECT rowid AS id, bm25(smart_fts, 3.0, 1.0) AS score
              FROM smart_fts WHERE smart_fts MATCH ?
              ORDER BY score, rowid LIMIT ?
            )
            SELECT d.document, r.score AS rank FROM ranked r
            CROSS JOIN smart_documents d ON d.id = r.id
            ORDER BY r.score, r.id`,
      useCover
        ? [...values, expression, limit]
        : [expression, ...values, limit],
      signal
    );
    signal?.throwIfAborted();
    const terms = words.map(foldText);
    const minimum = words.length >= 4 ? Math.ceil(words.length / 3) : 1;
    return rows
      .map((row) => ({
        document: JSON.parse(row.document) as SmartDocument,
        score: -row.rank,
        methods: ['lexical'] as SmartMatch['methods'],
      }))
      .filter(({ document }) => {
        const text = foldText(`${document.title} ${document.overview}`);
        return terms.filter((word) => text.includes(word)).length >= minimum;
      });
  }

  async searchKeywords(
    query: string,
    filters: SmartFilters = {},
    limit = 60,
    signal?: AbortSignal
  ): Promise<SmartMatch[]> {
    signal?.throwIfAborted();
    const words = plotSearchWords(query);
    limit = Math.min(500, Math.floor(limit));
    if (!(limit > 0) || !words.length) return [];
    const { clauses, values } = metadataConditions(filters);
    const conditions = ['smart_keywords MATCH ?', ...clauses];
    const rows = await this.readSearchRows<{
      id: number;
      document: string;
      keywords: string;
      votes: number;
      rank: number;
    }>(
      `WITH ranked AS MATERIALIZED (
        SELECT smart_keywords.rowid AS id, smart_keywords.rank AS rank
        FROM smart_keywords CROSS JOIN smart_documents d ON d.id = smart_keywords.rowid
        WHERE ${conditions.join(' AND ')} ORDER BY smart_keywords.rank LIMIT ?
      )
      SELECT r.id, r.rank, d.document, d.voteCount AS votes, k.keywords
      FROM ranked r JOIN smart_documents d ON d.id = r.id
      JOIN smart_keywords k ON k.rowid = r.id`,
      [ftsTerms(words, true), ...values, Math.max(100, limit * 4)],
      signal
    );
    signal?.throwIfAborted();
    // Prefer documents that match separate terms. A small audience prior
    // cannot make a popular one-term hit outrank a two-term match.
    const token = (word: string): string =>
      foldText(word).replace(/^([a-z]{4,})(?:ing|s)$/u, '$1');
    const terms = [...new Set(words.map(token))];
    return rows
      .map((row) => {
        const keywords = wordsIn(row.keywords).map(token);
        const matches = terms.filter((term) =>
          keywords.some(
            (keyword) =>
              keyword === term ||
              (keywordPrefix(term) && keyword.startsWith(term))
          )
        ).length;
        const audience =
          Math.log1p(Math.min(5000, Math.max(0, row.votes))) / Math.log1p(5000);
        return { ...row, matches, audience };
      })
      .sort(
        (a, b) =>
          b.matches - a.matches ||
          a.rank - b.rank ||
          b.audience - a.audience ||
          a.id - b.id
      )
      .slice(0, limit)
      .map(({ document, matches, audience }) => ({
        document: JSON.parse(document) as SmartDocument,
        score: matches + 0.15 * audience,
        methods: ['tmdb-keyword'],
      }));
  }

  async nextKeywordEnrichment(
    source: string,
    limit: number
  ): Promise<{ id: number; mediaType: SmartMediaType; sourceId: string }[]> {
    limit = Math.min(128, Math.floor(limit));
    if (!(limit > 0)) return [];
    return this.read((connection) =>
      this.all(
        `SELECT d.id, d.mediaType, d.sourceId
        FROM smart_documents d INDEXED BY smart_keyword_enrichment
        WHERE d.source = ? AND d.voteCount >= ${minKeywordEnrichmentVotes}
        AND NOT EXISTS (SELECT 1 FROM smart_keywords k WHERE k.rowid = d.id)
        ORDER BY d.voteCount DESC, d.id LIMIT ?`,
        [source, limit],
        connection
      )
    );
  }

  async setKeywords(
    source: string,
    mediaType: SmartMediaType,
    sourceId: string,
    keywords: string[]
  ): Promise<void> {
    const text = keywords
      .slice(0, maxKeywords)
      .map((keyword) => Array.from(keyword).slice(0, maxKeywordLength).join(''))
      .join('\n');
    await this.run(
      `INSERT OR REPLACE INTO smart_keywords(rowid, keywords)
      SELECT d.id, ? FROM smart_documents d
      WHERE d.source = ? AND d.mediaType = ? AND d.sourceId = ?
        AND (SELECT keywords FROM smart_keywords WHERE rowid = d.id) IS NOT ?`,
      [text, source, mediaType, sourceId, text]
    );
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
      WHERE smart_documents.hash != excluded.hash OR smart_documents.document != excluded.document
        OR (json_type(excluded.document, '$.keywords') = 'array'
          AND (SELECT keywords FROM smart_keywords WHERE rowid = smart_documents.id)
            IS NOT ${storedKeywords('excluded.document')})`,
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
  async findDocuments(
    source: string,
    type: SmartMediaType,
    ids: string[]
  ): Promise<SmartDocument[]> {
    if (!ids.length) return [];
    const rows = await this.all<{ document: string }>(
      `SELECT document FROM smart_documents WHERE source = ? AND mediaType = ? AND sourceId IN (${ids.map(() => '?').join(',')})`,
      [source, type, ...ids]
    );
    return rows.map(({ document }) => JSON.parse(document) as SmartDocument);
  }
  private async nativeSearch(
    snapshot: sqlite3.Database,
    vectors: readonly Buffer[],
    scanIndex: string,
    conditions: string[],
    filters: (string | number)[],
    limit: number,
    signal?: AbortSignal
  ): Promise<DenseHit[][] | undefined> {
    const extension = this.vectorExtension;
    if (
      !extension ||
      !this.canLoadVectorExtension ||
      limit > 1024 ||
      vectors.length > 8 ||
      vectors.some((vector) => !vector.length || vector.length > 4096)
    )
      return undefined;
    if (!this.nativeReaders.has(snapshot)) {
      try {
        await new Promise<void>((resolve, reject) =>
          snapshot.loadExtension(extension, (error) =>
            error ? reject(error) : resolve()
          )
        );
      } catch {
        // Keep the portable path available on builds without extension support.
        this.canLoadVectorExtension = false;
        return undefined;
      }
      this.nativeReaders.add(snapshot);
    }
    this.vectorExtensionLoaded = true;
    this.nativeVoteRanking ??= await this.all(
      "SELECT 1 FROM pragma_function_list WHERE name = 'seerr_top_votes' AND narg = 6",
      [],
      snapshot
    ).then(
      (rows) => rows.length > 0,
      () => false
    );
    signal?.throwIfAborted();
    const interrupt = () => snapshot.interrupt();
    signal?.addEventListener('abort', interrupt, { once: true });
    try {
      const expressions = vectors.map((_, index) =>
        this.nativeVoteRanking
          ? `seerr_top_votes(?, ?, vector, voteCount, id, ?) AS hits${index}`
          : `seerr_top(?, ?, vector, seerr_votes(?, voteCount), id) AS hits${index}`
      );
      const [row] = await this.all<Record<string, Buffer | null>>(
        `SELECT ${expressions.join(', ')} FROM smart_documents ${scanIndex} WHERE ${conditions.join(' AND ')}`,
        [
          ...vectors.flatMap((vector) => [vector, limit, nativeVoteBonuses]),
          0,
          ...filters,
        ],
        snapshot
      );
      signal?.throwIfAborted();
      return vectors.map((_, index) => {
        const result = row[`hits${index}`];
        const hits: DenseHit[] = [];
        if (result) {
          for (let offset = 0; offset < result.length; offset += 16) {
            hits.push({
              id: Number(
                littleEndian
                  ? result.readBigInt64LE(offset)
                  : result.readBigInt64BE(offset)
              ),
              score: littleEndian
                ? result.readDoubleLE(offset + 8)
                : result.readDoubleBE(offset + 8),
            });
          }
        }
        return hits;
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener('abort', interrupt);
    }
  }

  private async loadDenseDocuments(
    hits: DenseHit[][],
    snapshot: sqlite3.Database
  ): Promise<SmartMatch[][]> {
    const documents = new Map<number, SmartDocument>();
    const ids = [
      ...new Set(hits.flatMap((group) => group.map(({ id }) => id))),
    ];
    for (let start = 0; start < ids.length; start += 500) {
      const batch = ids.slice(start, start + 500);
      const rows = await this.all<Pick<Row, 'id' | 'document'>>(
        `SELECT id, document FROM smart_documents WHERE id IN (${batch.map(() => '?').join(',')})`,
        batch,
        snapshot
      );
      rows.forEach((row) => documents.set(row.id, JSON.parse(row.document)));
    }
    return hits.map((group) =>
      group.flatMap(({ id, score }) => {
        const document = documents.get(id);
        return document ? [{ document, score }] : [];
      })
    );
  }

  async search(
    vector: Buffer,
    filters: SmartFilters = {},
    limit = 30,
    signal?: AbortSignal
  ): Promise<SmartMatch[]> {
    return (await this.searchMany([vector], filters, limit, signal))[0];
  }

  async searchMany(
    vectors: readonly Buffer[],
    filters: SmartFilters = {},
    limit = 30,
    signal?: AbortSignal
  ): Promise<SmartMatch[][]> {
    return this.searchVectors(vectors, filters, limit, signal);
  }

  /** Reuse exact neighbors for recurring title seeds as the catalog changes. */
  async searchNeighbors(
    vectors: readonly Buffer[],
    filters: SmartFilters,
    limit: number
  ): Promise<SmartMatch[][]> {
    return this.searchVectors(vectors, filters, limit, undefined, limit <= 250);
  }

  private async searchVectors(
    vectors: readonly Buffer[],
    filters: SmartFilters,
    limit: number,
    signal?: AbortSignal,
    reuseNeighbors = false
  ): Promise<SmartMatch[][]> {
    signal?.throwIfAborted();
    if (this.closing) throw new Error('Search index is closing');
    limit = Math.floor(limit);
    if (!(limit > 0) || !vectors.length) return vectors.map(() => []);
    // The writer continues indexing on the main connection. A separate,
    // read-only transaction keeps the vector and final document in the same
    // snapshot even when a title is updated or removed during the scan.
    return this.read(async (snapshot, transient) => {
      signal?.throwIfAborted();
      if (reuseNeighbors && !transient)
        return await this.searchNeighborSnapshot(
          snapshot,
          vectors,
          filters,
          limit
        );
      const hits = await this.scanDense(snapshot, vectors, filters, limit, {
        signal,
        transient,
      });
      if (transient)
        return hits.map((group) =>
          group.map(({ document, score }) => ({
            document: JSON.parse(document!) as SmartDocument,
            score,
          }))
        );
      return await this.loadDenseDocuments(hits, snapshot);
    }, true);
  }
  private async scanDense(
    snapshot: sqlite3.Database,
    vectors: readonly Buffer[],
    filters: SmartFilters,
    limit: number,
    {
      signal,
      transient,
      ids,
    }: {
      signal?: AbortSignal;
      transient?: boolean;
      ids?: ReadonlySet<number>;
    } = {}
  ): Promise<DenseHit[][]> {
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
    if (ids) {
      if (!ids.size) return vectors.map(() => []);
      conditions.push('id IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify([...ids]));
    }
    if (!transient) {
      const useCover = this.denseCoverAvailable && !ids;
      // mediaType precedes language in the covering index. Equality on the
      // supported types lets SQLite seek directly to a selected language.
      const restrictCoverTypes =
        useCover && filters.language && !filters.mediaType;
      const native = await this.nativeSearch(
        snapshot,
        vectors,
        ids ? 'NOT INDEXED' : useCover ? 'INDEXED BY smart_dense_cover' : '',
        restrictCoverTypes
          ? [
              ...conditions,
              `mediaType IN (${smartMediaTypes.map(() => '?').join(',')})`,
            ]
          : conditions,
        restrictCoverTypes ? [...params, ...smartMediaTypes] : params,
        limit,
        signal
      );
      if (native) return native;
    }
    // For a fixed language, this index walks matching row IDs in order
    // without sorting or scanning titles in all the other languages.
    const scanIndex =
      !ids && filters.language
        ? 'INDEXED BY smart_original_language'
        : 'NOT INDEXED';
    let after = 0;
    const queries = vectors.map((vector) => ({
      score: prepareCosine(vector),
      best: [] as {
        id: number;
        score: number;
        rank: number;
        document?: string;
      }[],
    }));
    for (;;) {
      signal?.throwIfAborted();
      const rows = await this.all<
        Pick<Row, 'id' | 'vector' | 'voteCount'> & { document?: string }
      >(
        `SELECT id, vector, voteCount${transient ? ', document' : ''} FROM smart_documents ${scanIndex} WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT 1024`,
        [after, ...params],
        snapshot
      );
      signal?.throwIfAborted();
      if (!rows.length) break;
      for (const row of rows) {
        // This bonus is independent of the query. Keep the exact order
        // when scanning several independent seeds in the same transaction.
        const votes = Math.max(0, row.voteCount);
        const bonus =
          denseVoteBonuses[votes] ??
          0.015 * Math.min(1, Math.log1p(votes) / Math.log(1001));
        const candidate = new Int8Array(
          row.vector.buffer,
          row.vector.byteOffset,
          row.vector.byteLength
        );
        for (const { score: similarity, best } of queries) {
          const score = similarity(candidate);
          const rank = score + bonus;
          if (best.length === limit && rank <= best[limit - 1].rank) continue;
          let low = 0;
          let high = best.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (rank > best[middle].rank) high = middle;
            else low = middle + 1;
          }
          best.splice(low, 0, {
            id: row.id,
            score,
            rank,
            document: row.document,
          });
          if (best.length > limit) best.pop();
        }
      }
      after = rows[rows.length - 1].id;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return queries.map(({ best }) => best);
  }

  private async searchNeighborSnapshot(
    snapshot: sqlite3.Database,
    vectors: readonly Buffer[],
    filters: SmartFilters,
    limit: number
  ): Promise<SmartMatch[][]> {
    const scope = [
      filters.mediaType,
      filters.language,
      filters.yearFrom,
      filters.yearTo,
      filters.genre,
      filters.minRating,
      filters.minVotes,
    ];
    if (
      scope.some(
        (value) => typeof value === 'number' && !Number.isFinite(value)
      )
    )
      return this.loadDenseDocuments(
        await this.scanDense(snapshot, vectors, filters, limit),
        snapshot
      );
    const [history] = await this.all<{ oldest: number; latest: number }>(
      `SELECT
        COALESCE((SELECT MIN(seq) FROM smart_neighbor_changes), 0) AS oldest,
        COALESCE((SELECT MAX(seq) FROM smart_neighbor_changes), 0) AS latest`,
      [],
      snapshot
    );
    const capacity = limit + neighborReserve;
    type Query = {
      vector: Buffer;
      key: string;
      previous?: NeighborPool;
      hits?: DenseHit[];
      matches?: SmartMatch[];
      safeCount: number;
      canBeExhaustive: boolean;
      changed?: Set<number>;
    };
    const queries: Query[] = vectors.map((vector) => {
      const key = JSON.stringify([vector.toString('base64'), limit, scope]);
      return {
        vector,
        key,
        previous: this.neighbors.get(key),
        safeCount: capacity,
        canBeExhaustive: true,
      };
    });
    const oldestCached = Math.min(
      history.latest,
      ...queries.flatMap(({ previous }) =>
        previous && previous.revision >= history.oldest - 1
          ? [previous.revision]
          : []
      )
    );
    const changes =
      oldestCached < history.latest
        ? await this.all<{ seq: number; id: number }>(
            'SELECT seq, id FROM smart_neighbor_changes WHERE seq > ?',
            [oldestCached],
            snapshot
          )
        : [];
    const cold: Query[] = [];
    const refresh: Query[] = [];
    const refreshIds = new Set<number>();
    for (const query of queries) {
      const previous = query.previous;
      if (previous?.revision === history.latest) {
        query.matches = previous.matches;
        continue;
      }
      if (
        previous &&
        previous.revision >= history.oldest - 1 &&
        previous.revision < history.latest
      ) {
        const changed = new Set(
          changes
            .filter(({ seq }) => seq > previous.revision)
            .map(({ id }) => id)
        );
        const untouched = previous.hits.filter(
          ({ id }) => !changed.has(id)
        ).length;
        // Unchanged cached hits still outrank every unchanged row outside the
        // pool. If the reserve cannot cover removals, run the exact full scan.
        const safeCount = previous.exhaustive ? capacity : untouched;
        if (safeCount >= limit && changed.size <= maxNeighborDelta) {
          query.safeCount = safeCount;
          query.canBeExhaustive = previous.exhaustive;
          query.changed = changed;
          refresh.push(query);
          for (const { id } of previous.hits) refreshIds.add(id);
          for (const id of changed) refreshIds.add(id);
          continue;
        }
      }
      cold.push(query);
    }
    if (cold.length) {
      const groups = await this.scanDense(
        snapshot,
        cold.map(({ vector }) => vector),
        filters,
        capacity
      );
      cold.forEach((query, index) => {
        query.hits = groups[index];
      });
    }
    if (refresh.length) {
      const groups = await this.scanDense(
        snapshot,
        refresh.map(({ vector }) => vector),
        filters,
        capacity,
        { ids: refreshIds }
      );
      refresh.forEach((query, index) => {
        query.hits = groups[index].slice(0, query.safeCount);
        const previous = query.previous!;
        if (
          query.hits
            .slice(0, limit)
            .every(
              ({ id, score }, position) =>
                previous.hits[position]?.id === id &&
                previous.hits[position].score === score &&
                !query.changed!.has(id)
            ) &&
          query.hits.slice(0, limit).length === previous.matches.length
        )
          query.matches = previous.matches;
      });
    }
    const toLoad = queries.filter((query) => !query.matches);
    const loaded = await this.loadDenseDocuments(
      toLoad.map(({ hits }) => hits!.slice(0, limit)),
      snapshot
    );
    toLoad.forEach((query, i) => {
      query.matches = loaded[i];
    });
    for (const { key, hits, matches, canBeExhaustive } of queries) {
      if (!hits || (this.neighbors.peek(key)?.revision ?? -1) > history.latest)
        continue;
      this.neighbors.set(key, {
        revision: history.latest,
        hits,
        matches: matches!,
        exhaustive: canBeExhaustive && hits.length < capacity,
      });
    }
    return queries.map(({ matches }) => matches!);
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.lexicalTask;
    await Promise.all(this.activeSearches);
    const idle = this.idleDenseReader;
    this.idleDenseReader = undefined;
    await Promise.all([
      this.closeConnection(this.db),
      idle && this.closeConnection(idle),
    ]);
  }
}
