import { createHash } from 'crypto';
import sqlite3 from 'sqlite3';
import type { SmartDocument, SmartFilters, SmartMediaType } from './types';
import { cosine } from './vectors';

export interface SmartMatch {
  document: SmartDocument;
  score: number;
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
  constructor(filename: string) {
    this.db = new sqlite3.Database(filename);
  }
  private run(
    sql: string,
    params: (string | number | Buffer | null)[] = []
  ): Promise<void> {
    return new Promise((resolve, reject) =>
      this.db.run(sql, params, (error) => (error ? reject(error) : resolve()))
    );
  }
  private all<T>(sql: string, params: (string | number)[] = []): Promise<T[]> {
    return new Promise((resolve, reject) =>
      this.db.all<T>(sql, params, (error, rows) =>
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
    await this.run(
      `INSERT INTO smart_documents(source, sourceId, mediaType, language, year, voteAverage, voteCount, genres, hash, vector, document) VALUES ${values}
      ON CONFLICT(source, sourceId, mediaType) DO UPDATE SET language=excluded.language, year=excluded.year, voteAverage=excluded.voteAverage, voteCount=excluded.voteCount, genres=excluded.genres, hash=excluded.hash, vector=excluded.vector, document=excluded.document
      WHERE smart_documents.hash != excluded.hash OR smart_documents.document != excluded.document`,
      params
    );
  }
  async remove(
    source: string,
    type: SmartMediaType,
    id: string
  ): Promise<void> {
    await this.run(
      'DELETE FROM smart_documents WHERE source = ? AND mediaType = ? AND sourceId = ?',
      [source, type, id]
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
    const best: (SmartMatch & { rank: number })[] = [];
    for (;;) {
      const rows = await this.all<Row>(
        `SELECT id, vector, document, voteCount FROM smart_documents WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT 512`,
        [after, ...params]
      );
      if (!rows.length) break;
      for (const row of rows) {
        const score = cosine(vector, row.vector);
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
            document: JSON.parse(row.document) as SmartDocument,
            score,
            rank,
          });
          best.sort((a, b) => b.rank - a.rank);
          if (best.length > limit) best.pop();
        }
      }
      after = rows[rows.length - 1].id;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return best.map(({ document, score }) => ({ document, score }));
  }
  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.db.close((error) => (error ? reject(error) : resolve()))
    );
  }
}
