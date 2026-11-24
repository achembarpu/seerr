import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { appDataPath } from '@server/utils/appDataVolume';
import { performance } from 'node:perf_hooks';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { EmbeddingEngine } from './engine';
import {
  documentHash,
  documentText,
  SmartStore,
  type SmartMatch,
} from './store';
import { TmdbMetadataSource } from './tmdb';
import type {
  MetadataSource,
  SmartDocument,
  SmartFilters,
  SmartMediaType,
} from './types';
import { cosine, quantize } from './vectors';

type Cursor = {
  year: number;
  mediaType: SmartMediaType;
  month: number;
  day?: number;
  page: number;
};
const firstYear = 1870;
const interval = 24 * 60 * 60 * 1000;
const retryInterval = 60 * 60 * 1000;
const rerankCacheLimit = 1024;
const rerankCacheTtl = 5 * 60 * 1000;
const denseCacheLimit = 8;
const denseCacheTtl = 30 * 1000;
const searchShortlistSize = 30;
const defaultRerankLimit = 40;
const maxRerankLimit = 80;
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

const rerankLimit = (maximum: number) =>
  Math.max(
    1,
    Math.min(
      maximum,
      Number(getSettings().main.smartSearchRerankCandidates) ||
        defaultRerankLimit
    )
  );

const matchKey = ({ document }: SmartMatch) =>
  `${document.mediaType}:${document.source}:${document.sourceId}`;

/** Keep offline upstream discovery from blocking the local index indefinitely. */
async function withDeadline<T>(
  operation: Promise<T>,
  timeout = 2500
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Search source timed out')),
          timeout
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const matchesFilters = (doc: SmartDocument, f: SmartFilters): boolean =>
  (!f.mediaType || doc.mediaType === f.mediaType) &&
  (!f.language || doc.originalLanguage === f.language) &&
  (f.yearFrom === undefined || (doc.year !== null && doc.year >= f.yearFrom)) &&
  (f.yearTo === undefined || (doc.year !== null && doc.year <= f.yearTo)) &&
  (f.genre === undefined || doc.genreIds.includes(f.genre)) &&
  (f.minRating === undefined || doc.voteAverage >= f.minRating) &&
  (f.minVotes === undefined || doc.voteCount >= f.minVotes);

/** Fuse independent ranked candidate lists without comparing incompatible score scales. */
export function fuseSmartCandidates(
  lists: SmartMatch[][],
  limit = 100
): SmartMatch[] {
  const entries = new Map<
    string,
    { item: SmartMatch; rank: number; order: number }
  >();
  let order = 0;
  for (const list of lists)
    list.forEach((item, index) => {
      const key = matchKey(item);
      const existing = entries.get(key);
      if (existing) {
        existing.rank += 1 / (40 + index + 1);
        for (const method of item.methods ?? [])
          if (!existing.item.methods?.includes(method))
            existing.item.methods?.push(method);
      } else
        entries.set(key, {
          item: { ...item, methods: [...(item.methods ?? [])] },
          rank: 1 / (40 + index + 1),
          order: order++,
        });
    });
  return [...entries.values()]
    .sort((a, b) => b.rank - a.rank || a.order - b.order)
    .slice(0, limit)
    .map(({ item, rank }) => ({ ...item, score: rank }));
}

/** Give each retrieval signal room in the expensive rerank pass. */
export function searchRerankShortlist(
  candidates: SmartMatch[],
  dense: SmartMatch[],
  words: number,
  budget: number
) {
  // Short queries leave more ambiguity. Keep the configured candidate budget
  // for those queries and for deliberately small budgets.
  if (
    words <= 4 ||
    budget < defaultRerankLimit ||
    candidates.length < defaultRerankLimit
  )
    return { candidates, limit: budget };

  const firstPage = candidates.slice(0, searchShortlistSize);
  const topDense = new Set(dense.slice(0, 12).map(matchKey));
  const kept = new Set(firstPage.slice(0, 15));
  for (const method of ['lexical', 'tmdb-keyword'] as const) {
    for (const match of firstPage
      .filter((item) => item.methods?.includes(method))
      .slice(0, 3))
      kept.add(match);
  }
  for (const item of firstPage) {
    if (topDense.has(matchKey(item)) || (item.methods?.length ?? 0) > 1)
      kept.add(item);
  }
  for (const item of firstPage) {
    if (kept.size >= 20) break;
    kept.add(item);
  }
  const selected = firstPage.filter((item) => kept.has(item));
  const deeper = candidates.slice(searchShortlistSize, budget);
  return {
    candidates: [
      ...selected,
      // Keep audience-backed candidates that can rescue overlooked titles.
      ...deeper,
      ...firstPage.filter((item) => !kept.has(item)),
      ...candidates.slice(budget),
    ],
    limit: selected.length + deeper.length,
  };
}

/** Give each seed a chance in the visible part of the Discover row. */
export function balanceRecommendationPools(
  pools: SmartMatch[][]
): SmartMatch[] {
  const key = ({ document }: SmartMatch) =>
    `${document.mediaType}:${document.sourceId}`;
  const rank = (pool: SmartMatch[]) => {
    const bestScore = pool[0]?.score || 1;
    const score = (item: SmartMatch) =>
      item.score +
      0.002 *
        ratingEvidence(item.document) *
        relevanceStrength(item.score / bestScore);
    return [...pool].sort((a, b) => score(b) - score(a));
  };
  const ranked = rank(fuseSmartCandidates(pools, 60));
  const active = pools.filter((pool) => pool.length > 0);
  if (active.length <= 1) return ranked.slice(0, 30);

  const selected = new Map<string, SmartMatch>();
  const perSeed = active.map(rank);
  for (let round = 0; round < 2; round++) {
    for (const pool of perSeed) {
      const match = pool.find((candidate) => !selected.has(key(candidate)));
      if (match) selected.set(key(match), match);
    }
  }
  for (const match of ranked) {
    if (selected.size >= 30) break;
    if (!selected.has(key(match))) selected.set(key(match), match);
  }
  return [...selected.values()];
}

const relevanceStrength = (score: number) =>
  Math.min(1, Math.max(0, (score - 0.3) / 0.7));

/** Favor compatible genres and formats. Audience size only breaks close ties. */
export function relatedPrior(
  seed: SmartDocument,
  candidate: SmartDocument,
  similarity = 1
) {
  const sourceGenres = new Set(seed.genreIds);
  const targetGenres = new Set(candidate.genreIds);
  const bothKnown = sourceGenres.size > 0 && targetGenres.size > 0;
  const overlap = [...sourceGenres].filter((genre) =>
    targetGenres.has(genre)
  ).length;
  const genreSimilarity = bothKnown
    ? (2 * overlap) / (sourceGenres.size + targetGenres.size)
    : 0;
  const audience = Math.min(
    1,
    Math.log1p(Math.max(0, candidate.voteCount)) / Math.log(10001)
  );
  const documentaryMismatch =
    bothKnown && sourceGenres.has(99) !== targetGenres.has(99);
  const animationMismatch =
    bothKnown && sourceGenres.has(16) !== targetGenres.has(16);
  return (
    0.06 * genreSimilarity +
    0.012 * audience * relevanceStrength(similarity) -
    (documentaryMismatch ? 0.15 : 0) -
    (animationMismatch ? 0.04 : 0)
  );
}

// Drama alone says little about a story's tone. When both titles have more
// specific genres, a shared setting alone is weaker evidence of similarity.
export function storyMatchPenalty(
  seed: SmartDocument,
  candidate: SmartDocument
): number {
  const broadGenres = [18, 36, 10770];
  const genres = seed.genreIds.filter((id) => !broadGenres.includes(id));
  const otherGenres = candidate.genreIds.filter(
    (id) => !broadGenres.includes(id)
  );
  const incompatible =
    genres.length > 0 &&
    candidate.genreIds.length > 0 &&
    !otherGenres.some((id) => genres.includes(id));
  let words = 0;
  for (const part of wordSegmenter.segment(candidate.overview)) {
    if (part.isWordLike && ++words === 16) break;
  }
  return (incompatible ? 0.012 : 0) + 0.008 * (1 - words / 16);
}

/** Shrink noisy ratings toward the catalog average; missing ratings are neutral. */
export function ratingEvidence(candidate: SmartDocument): number {
  const { voteAverage, voteCount } = candidate;
  if (
    !Number.isFinite(voteAverage) ||
    !Number.isFinite(voteCount) ||
    voteAverage <= 0 ||
    voteCount <= 0
  )
    return 0;
  const confidence = voteCount / (voteCount + 250);
  return Math.max(-1, Math.min(1, (voteAverage - 6.7) / 3.3)) * confidence;
}

export class SmartSearchService {
  constructor(
    private readonly enabled: () => boolean = () =>
      !!getSettings().main.smartSearch,
    private readonly engine: Pick<
      EmbeddingEngine,
      'phase' | 'downloadBytes' | 'downloadTotal' | 'start' | 'stop' | 'embed'
    > &
      Partial<
        Pick<
          EmbeddingEngine,
          'devices' | 'activeDevice' | 'deviceWarning' | 'externalAvailable'
        >
      > = new EmbeddingEngine(
      () => getSettings().main.smartSearchDevice || 'auto'
    ),
    private readonly source: MetadataSource = new TmdbMetadataSource(),
    private readonly createStore: () => SmartStore = () =>
      new SmartStore(path.join(appDataPath(), 'smart-search.sqlite3'))
  ) {}
  private readonly reranker = new EmbeddingEngine(
    () => getSettings().main.smartSearchDevice || 'auto',
    'reranking'
  );
  private rerankerError?: string;
  private rerankerRetryAt = 0;
  private rerankerBusy = false;
  private rerankerDone?: Promise<void>;
  private rerankCacheGeneration = 0;
  private readonly rerankScoreCache = new Map<
    string,
    { score: number; expiresAt: number }
  >();
  private retrievalWarning?: string;
  private denseBusy = false;
  private denseWaiters = 0;
  private denseDone?: Promise<void>;
  private denseCacheGeneration = 0;
  private readonly denseCache = new Map<
    string,
    { version: string; expiresAt: number; matches: SmartMatch[] }
  >();
  private rerankerIdle?: NodeJS.Timeout;
  private closing = false;
  private store?: SmartStore;
  private opening?: Promise<SmartStore>;
  private controller?: AbortController;
  private timer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private runtimeController = new AbortController();
  private cursor?: Cursor;
  private popularCursor?: {
    type: SmartMediaType;
    page: number;
    totalPages: number;
  };
  private readonly seedCache = new Map<
    string,
    { document: SmartDocument; vector: Buffer }
  >();
  private count = 0;
  private error?: string;
  private nextRefreshAt?: string;
  private inFlight?: Promise<void>;

  status() {
    return {
      enabled: this.enabled(),
      phase: this.engine.phase,
      indexing: !!this.controller,
      count: this.count,
      cursor: this.cursor,
      popularCursor: this.popularCursor,
      error: this.error,
      nextRefreshAt: this.nextRefreshAt,
      downloadBytes: this.engine.downloadBytes,
      downloadTotal: this.engine.downloadTotal,
      devices: this.engine.devices ?? [],
      externalAvailable: this.engine.externalAvailable ?? false,
      activeDevice: this.engine.activeDevice,
      vectorBackend: this.store?.vectorBackend,
      deviceWarning: this.engine.deviceWarning,
      lexical: this.lexicalStatus(),
      retrievalWarning: this.retrievalWarning,
      reranker: {
        enabled: this.rerankerEnabled(),
        phase: this.reranker.phase,
        downloadBytes: this.reranker.downloadBytes,
        downloadTotal: this.reranker.downloadTotal,
        activeDevice: this.reranker.activeDevice,
        error: this.rerankerError,
      },
    };
  }

  private lexicalStatus() {
    const status = this.store?.lexicalStatus();
    if (!status) return { indexed: 0, total: this.count, indexing: false };
    return {
      ...status,
      total: this.count,
      indexed: status.complete
        ? this.count
        : Math.min(this.count, status.indexed),
    };
  }

  private rerankerEnabled(): boolean {
    return this.enabled() && !!getSettings().main.smartSearchRerank;
  }

  private async prepareReranker(): Promise<void> {
    if (!this.rerankerEnabled()) return;
    if (this.reranker.phase !== 'ready') this.clearRerankScores();
    if (this.rerankerIdle) clearTimeout(this.rerankerIdle);
    this.rerankerIdle = undefined;
    if (this.runtimeController.signal.aborted)
      this.runtimeController = new AbortController();
    try {
      await this.reranker.start(this.runtimeController.signal);
      this.rerankerError = undefined;
    } catch (error) {
      this.rerankerError =
        error instanceof Error ? error.message : String(error);
      this.rerankerRetryAt = Date.now() + 60000;
      throw error;
    }
  }

  private releaseReranker(): void {
    if (this.rerankerIdle) clearTimeout(this.rerankerIdle);
    this.rerankerIdle = setTimeout(
      () => {
        this.reranker.stop();
        this.clearRerankScores();
        this.rerankerIdle = undefined;
      },
      15 * 60 * 1000
    );
    this.rerankerIdle.unref();
  }

  private clearRerankScores(): void {
    this.rerankCacheGeneration++;
    this.rerankScoreCache.clear();
  }

  private clearDenseCache(): void {
    this.denseCacheGeneration++;
    this.denseCache.clear();
  }

  private cachedRerankScore(key: string, now: number): number | undefined {
    const value = this.rerankScoreCache.get(key);
    if (!value) return undefined;
    this.rerankScoreCache.delete(key);
    if (value.expiresAt <= now) return undefined;
    this.rerankScoreCache.set(key, value);
    return value.score;
  }

  private rememberRerankScore(key: string, score: number, now: number): void {
    this.rerankScoreCache.delete(key);
    this.rerankScoreCache.set(key, { score, expiresAt: now + rerankCacheTtl });
    while (this.rerankScoreCache.size > rerankCacheLimit)
      this.rerankScoreCache.delete(this.rerankScoreCache.keys().next().value!);
  }

  private async rerank(
    query: string,
    candidates: SmartMatch[],
    maxCandidates = maxRerankLimit,
    timeout = 6000,
    mode: 'search' | 'similar' = 'search',
    signal?: AbortSignal
  ): Promise<SmartMatch[]> {
    signal?.throwIfAborted();
    if (!this.rerankerEnabled() || !candidates.length) return candidates;
    if (this.reranker.phase !== 'ready') {
      this.clearRerankScores();
      if (this.reranker.phase === 'idle' && Date.now() >= this.rerankerRetryAt)
        void this.prepareReranker()
          .then(() => this.releaseReranker())
          .catch(() => undefined);
      return candidates;
    }
    const limit = rerankLimit(maxCandidates);
    const prefix = candidates.slice(0, limit);
    const docs = prefix.map(({ document }) =>
      mode === 'similar'
        ? documentText(document)
        : `Title: ${document.title}. Description: ${document.overview}`.slice(
            0,
            700
          )
    );
    const modelQuery = query.slice(0, 600);
    const keys = docs.map((doc) => JSON.stringify([modelQuery, doc]));
    const generation = this.rerankCacheGeneration;
    const readScores = () => {
      const now = performance.now();
      return keys.map((key) => this.cachedRerankScore(key, now));
    };
    let values = readScores();
    if (
      values.some((score) => score === undefined) &&
      this.rerankerBusy &&
      this.rerankerDone
    ) {
      await Promise.race([
        this.rerankerDone,
        delay(750, undefined, { signal }),
      ]);
      if (this.rerankerBusy || generation !== this.rerankCacheGeneration)
        return candidates;
      values = readScores();
    }
    if (!this.rerankerEnabled() || this.reranker.phase !== 'ready')
      return candidates;
    const missing = new Map<string, string>();
    values.forEach((score, index) => {
      if (score === undefined) missing.set(keys[index], docs[index]);
    });
    let finish: () => void = () => undefined;
    if (missing.size) {
      this.rerankerBusy = true;
      this.rerankerDone = new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    try {
      if (missing.size) {
        const missingKeys = [...missing.keys()];
        const newScores = await this.reranker.rerank(
          modelQuery,
          [...missing.values()],
          timeout,
          signal
        );
        if (
          newScores.length !== missingKeys.length ||
          newScores.some((score) => !Number.isFinite(score))
        )
          throw new Error('Invalid reranker response');
        if (
          generation !== this.rerankCacheGeneration ||
          !this.rerankerEnabled() ||
          this.reranker.phase !== 'ready'
        )
          return candidates;
        const now = performance.now();
        missingKeys.forEach((key, index) =>
          this.rememberRerankScore(key, newScores[index], now)
        );
        const computed = new Map(
          missingKeys.map((key, index) => [key, newScores[index]])
        );
        // Keep scores that were valid when the request started. A cached
        // entry can expire while inference for the other documents runs.
        values = values.map(
          (score, index) => score ?? computed.get(keys[index])
        );
        this.rerankerError = undefined;
        this.rerankerRetryAt = 0;
      }
      const scores = values.map((score) => {
        if (score === undefined) throw new Error('Incomplete reranker scores');
        return score;
      });
      const baseline = prefix.map(
        (item, index): SmartMatch => ({
          ...item,
          reranked: true,
          relevanceScore: scores[index],
        })
      );
      const ranked = baseline
        .map((item, i) => ({ ...item, score: scores[i] }))
        .sort((a, b) => b.score - a.score);
      // The model can demote good cross-language matches. Combine rankings
      // without comparing uncalibrated scores, retaining a retrieval bias.
      const lists =
        mode === 'similar'
          ? [baseline, ranked, ranked]
          : [baseline, baseline, ranked];
      return fuseSmartCandidates(lists, limit).concat(candidates.slice(limit));
    } catch (error) {
      signal?.throwIfAborted();
      this.clearRerankScores();
      this.rerankerError =
        error instanceof Error ? error.message : String(error);
      logger.warn('Smart reranking unavailable; using hybrid order', {
        label: 'Smart Search',
        errorMessage: this.rerankerError,
      });
      return candidates;
    } finally {
      if (missing.size) {
        this.rerankerBusy = false;
        finish();
        this.rerankerDone = undefined;
      }
      this.releaseReranker();
    }
  }

  start(): void {
    if (this.closing) return;
    if (!this.enabled()) {
      this.clearRerankScores();
      this.clearDenseCache();
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.nextRefreshAt = undefined;
      this.controller?.abort();
      this.store?.pauseLexical();
      this.runtimeController.abort();
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
      this.engine.stop();
      this.reranker.stop();
      if (this.rerankerIdle) clearTimeout(this.rerankerIdle);
      return;
    }
    this.store?.resumeLexical();
    if (this.rerankerEnabled())
      void this.prepareReranker()
        .then(() => this.releaseReranker())
        .catch(() => undefined);
    if (getSettings().main.smartSearchRefreshInterval === 'manual') {
      void this.open().catch((error) => {
        this.error = String(error);
      });
      return;
    }
    if (!this.controller && !this.timer) {
      this.inFlight = this.refresh().catch((error) => {
        logger.error('Smart search failed', {
          label: 'Smart Search',
          errorMessage: String(error),
        });
      });
    }
  }

  reconfigure(): void {
    this.clearRerankScores();
    this.clearDenseCache();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRefreshAt = undefined;
    this.controller?.abort();
    this.runtimeController.abort();
    this.engine.stop();
    this.reranker.stop();
    if (this.rerankerIdle) clearTimeout(this.rerankerIdle);
    if (!this.controller) this.start();
  }

  refreshNow(): boolean {
    if (!this.enabled() || this.controller) return false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRefreshAt = undefined;
    this.inFlight = this.refresh();
    return true;
  }

  private schedule(delay: number): void {
    this.nextRefreshAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.nextRefreshAt = undefined;
      this.start();
    }, delay);
    this.timer.unref();
  }

  private async startEngine(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.runtimeController.signal.aborted)
      this.runtimeController = new AbortController();
    await this.engine.start(
      this.controller?.signal ?? this.runtimeController.signal
    );
  }

  private unloadWhenIdle(): void {
    if (this.controller || !this.enabled()) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => {
        this.idleTimer = undefined;
        this.engine.stop();
      },
      15 * 60 * 1000
    );
    this.idleTimer.unref();
  }

  private async open(): Promise<SmartStore> {
    if (this.store) return this.store;
    if (this.opening) return this.opening;
    const store = this.createStore();
    this.opening = (async () => {
      try {
        await store.initialize();
        this.count = await store.count();
        const saved = await store.getState('cursor');
        this.cursor = saved ? (JSON.parse(saved) as Cursor) : undefined;
        const popular = await store.getState('popularBootstrapCursor');
        this.popularCursor =
          popular && popular !== 'complete'
            ? { ...JSON.parse(popular), totalPages: 25 }
            : undefined;
        this.store = store;
        if (!this.enabled()) store.pauseLexical();
        return store;
      } catch (error) {
        await store.close().catch(() => undefined);
        throw error;
      }
    })();
    try {
      return await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  private async indexDocuments(
    store: SmartStore,
    mediaType: SmartMediaType,
    documents: SmartDocument[],
    signal: AbortSignal
  ): Promise<void> {
    const previous = await store.existing(
      this.source.id,
      mediaType,
      documents.map((doc) => doc.sourceId)
    );
    const changed = documents.filter(
      (doc) => previous.get(doc.sourceId)?.hash !== documentHash(doc)
    );
    const fresh = new Map<string, Buffer>();
    for (let offset = 0; offset < changed.length; offset += 8) {
      signal.throwIfAborted();
      const part = changed.slice(offset, offset + 8);
      const embeddings = await this.engine.embed(
        part.map(documentText),
        signal
      );
      signal.throwIfAborted();
      for (let i = 0; i < part.length; i++)
        fresh.set(part[i].sourceId, quantize(embeddings[i]));
    }
    await store.upsertBatch(
      documents.map((document) => ({
        document,
        vector:
          fresh.get(document.sourceId) ??
          previous.get(document.sourceId)!.vector,
      }))
    );
  }

  private async updateChanges(
    store: SmartStore,
    since: string,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.source.fetchChanges)
      throw new Error('Source does not support incremental updates');
    const today = new Date().toISOString().slice(0, 10);
    const saved = await store.getState('changesCursor');
    let cursor: { date: string; mediaType: SmartMediaType; page: number } =
      saved ? JSON.parse(saved) : { date: since, mediaType: 'movie', page: 1 };
    while (cursor.date <= today) {
      signal.throwIfAborted();
      const batch = await this.source.fetchChanges(
        cursor.mediaType,
        cursor.date,
        cursor.date,
        cursor.page,
        signal
      );
      if (batch.totalPages > 500)
        throw new Error(
          `Too many changes for ${cursor.date}; a full reconciliation is required.`
        );
      const documents: SmartDocument[] = [];
      for (const id of batch.ids) {
        signal.throwIfAborted();
        await delay(250, undefined, { signal });
        try {
          const document = await this.source.fetchOne(
            cursor.mediaType,
            id,
            signal
          );
          if (document) documents.push(document);
          else await store.remove(this.source.id, cursor.mediaType, id);
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'response' in error &&
            (error as { response?: { status?: number } }).response?.status ===
              404
          )
            await store.remove(this.source.id, cursor.mediaType, id);
          else throw error;
        }
      }
      await this.indexDocuments(store, cursor.mediaType, documents, signal);
      this.count = await store.count();
      if (cursor.page < batch.totalPages)
        cursor = { ...cursor, page: cursor.page + 1 };
      else if (cursor.mediaType === 'movie')
        cursor = { ...cursor, mediaType: 'tv', page: 1 };
      else
        cursor = {
          date: new Date(Date.parse(`${cursor.date}T00:00:00Z`) + 86400000)
            .toISOString()
            .slice(0, 10),
          mediaType: 'movie',
          page: 1,
        };
      await store.setState('changesCursor', JSON.stringify(cursor));
    }
    await store.setState('lastUpdated', today);
    await store.setState('changesCursor', '');
  }

  private async indexPopular(
    store: SmartStore,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.source.fetchPopular) return;
    const saved = await store.getState('popularBootstrapCursor');
    if (saved === 'complete') return;
    let cursor: { type: SmartMediaType; page: number } = saved
      ? JSON.parse(saved)
      : { type: 'movie', page: 1 };
    // A small independent first pass makes well-known older films discoverable
    // without resetting the existing chronological scan or embedding data.
    while (!signal.aborted) {
      this.popularCursor = { ...cursor, totalPages: 25 };
      const batch = await this.source.fetchPopular(
        cursor.type,
        cursor.page,
        signal
      );
      signal.throwIfAborted();
      await this.indexDocuments(store, cursor.type, batch.documents, signal);
      this.count = await store.count();
      if (cursor.page < Math.min(25, batch.totalPages))
        cursor = { ...cursor, page: cursor.page + 1 };
      else if (cursor.type === 'movie') cursor = { type: 'tv', page: 1 };
      else {
        await store.setState('popularBootstrapCursor', 'complete');
        this.popularCursor = undefined;
        return;
      }
      await store.setState('popularBootstrapCursor', JSON.stringify(cursor));
    }
  }

  private async refresh(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.error = undefined;
    let failed = false;
    try {
      const store = await this.open();
      await this.startEngine();
      try {
        await this.indexPopular(store, controller.signal);
      } catch (error) {
        controller.signal.throwIfAborted();
        logger.warn(
          'Popular search bootstrap failed; continuing the existing scan',
          { label: 'Smart Search', errorMessage: String(error) }
        );
      }
      const lastUpdated = await store.getState('lastUpdated');
      if (lastUpdated && this.source.fetchChanges) {
        await this.updateChanges(store, lastUpdated, controller.signal);
        return;
      }
      const saved = await store.getState('cursor');
      let scanStarted = await store.getState('scanStarted');
      if (!saved || !scanStarted) {
        scanStarted = new Date().toISOString().slice(0, 10);
        await store.setState('scanStarted', scanStarted);
        await store.setState('lastUpdated', '');
        await store.setState('changesCursor', '');
      }
      this.cursor = saved
        ? (JSON.parse(saved) as Cursor)
        : {
            year: new Date().getUTCFullYear() + 1,
            mediaType: 'movie',
            month: 0,
            page: 1,
          };
      while (this.cursor.year >= firstYear) {
        controller.signal.throwIfAborted();
        const cursor: Cursor = this.cursor;
        const { year, month, page, mediaType } = cursor;
        const day = cursor.day ?? 0;
        const from = month
          ? `${year}-${String(month).padStart(2, '0')}-${String(day || 1).padStart(2, '0')}`
          : `${year}-01-01`;
        const last = month
          ? new Date(Date.UTC(year, month, 0)).getUTCDate()
          : 31;
        const to = month
          ? `${year}-${String(month).padStart(2, '0')}-${String(day || last).padStart(2, '0')}`
          : `${year}-12-31`;
        const batch = await this.source.fetchPage(
          mediaType,
          from,
          to,
          page,
          controller.signal
        );
        controller.signal.throwIfAborted();
        if (batch.totalPages > 500 && month === 0) {
          this.cursor = { year, month: 1, page: 1, mediaType };
          await store.setState('cursor', JSON.stringify(this.cursor));
          continue;
        }
        if (batch.totalPages > 500 && month && !day) {
          this.cursor = { year, month, day: 1, page: 1, mediaType };
          await store.setState('cursor', JSON.stringify(this.cursor));
          continue;
        }
        if (batch.totalPages > 500)
          throw new Error(
            `TMDB returned more than 500 pages for ${mediaType} ${from}–${to}; indexing stopped to avoid missing titles.`
          );
        await this.indexDocuments(
          store,
          mediaType,
          batch.documents,
          controller.signal
        );
        this.count = await store.count();
        if (page < Math.min(batch.totalPages, 500))
          this.cursor = { year, mediaType, month, day, page: page + 1 };
        else if (day && day < last)
          this.cursor = { year, mediaType, month, day: day + 1, page: 1 };
        else if (month && month < 12)
          this.cursor = { year, mediaType, month: month + 1, page: 1 };
        else if (mediaType === 'movie')
          this.cursor = { year, mediaType: 'tv', month: 0, page: 1 };
        else
          this.cursor = {
            year: year - 1,
            mediaType: 'movie',
            month: 0,
            page: 1,
          };
        await store.setState('cursor', JSON.stringify(this.cursor));
      }
      await store.setState('cursor', '');
      await store.setState('lastUpdated', scanStarted);
      await store.setState('scanStarted', '');
      this.cursor = undefined;
    } catch (error) {
      if (!controller.signal.aborted) {
        failed = true;
        this.error = error instanceof Error ? error.message : String(error);
        logger.warn('Smart search indexing failed', {
          label: 'Smart Search',
          errorMessage: this.error,
        });
      }
    } finally {
      this.controller = undefined;
      this.unloadWhenIdle();
      if (this.enabled() && !this.closing) {
        if (controller.signal.aborted) this.start();
        else {
          const schedule = getSettings().main.smartSearchRefreshInterval;
          if (schedule !== 'manual')
            this.schedule(
              failed
                ? retryInterval
                : schedule === 'weekly'
                  ? interval * 7
                  : interval
            );
        }
      }
    }
  }

  private async searchDense(
    vector: Buffer,
    filters: SmartFilters,
    limit: number,
    signal?: AbortSignal
  ): Promise<SmartMatch[]> {
    signal?.throwIfAborted();
    const store = this.store;
    if (!store) throw new Error('Local semantic search is unavailable');
    const requestedVector = Buffer.from(vector);
    const requestedFilters = { ...filters };
    const cacheKey = JSON.stringify([
      requestedVector.toString('base64'),
      limit,
      requestedFilters.mediaType,
      requestedFilters.language,
      requestedFilters.yearFrom,
      requestedFilters.yearTo,
      requestedFilters.genre,
      requestedFilters.minRating,
      requestedFilters.minVotes,
    ]);
    const cacheable =
      Number.isFinite(limit) &&
      [
        requestedFilters.yearFrom,
        requestedFilters.yearTo,
        requestedFilters.genre,
        requestedFilters.minRating,
        requestedFilters.minVotes,
      ].every((value) => value === undefined || Number.isFinite(value));
    const generation = this.denseCacheGeneration;
    const version = async () => {
      try {
        return await store.documentVersion();
      } catch {
        // An unavailable version must never make the optimization fail a
        // search or return an unverified cached result.
        this.denseCache.clear();
        return undefined;
      }
    };
    const findCached = async () => {
      const current = await version();
      if (
        !cacheable ||
        !current ||
        generation !== this.denseCacheGeneration ||
        this.store !== store
      )
        return { current: undefined, matches: undefined };
      const entry = this.denseCache.get(cacheKey);
      if (
        !entry ||
        entry.version !== current ||
        entry.expiresAt <= performance.now()
      ) {
        this.denseCache.delete(cacheKey);
        return { current, matches: undefined };
      }
      try {
        const matches = structuredClone(entry.matches);
        const after = await version();
        if (
          after !== current ||
          entry.expiresAt <= performance.now() ||
          generation !== this.denseCacheGeneration ||
          this.store !== store
        ) {
          if (this.denseCache.get(cacheKey) === entry)
            this.denseCache.delete(cacheKey);
          return { current: undefined, matches: undefined };
        }
        this.denseCache.delete(cacheKey);
        this.denseCache.set(cacheKey, entry);
        return { current, matches };
      } catch {
        this.denseCache.delete(cacheKey);
        return { current, matches: undefined };
      }
    };
    let lookup = await findCached();
    if (lookup.matches) return lookup.matches;
    const waited = this.denseBusy;
    return this.runDenseScan(async () => {
      if (waited) {
        lookup = await findCached();
        if (lookup.matches) return lookup.matches;
      }
      const matches = await store.search(
        requestedVector,
        requestedFilters,
        limit,
        signal
      );
      if (
        lookup.current &&
        generation === this.denseCacheGeneration &&
        this.store === store &&
        !this.closing
      ) {
        const after = await version();
        if (
          after === lookup.current &&
          generation === this.denseCacheGeneration &&
          this.store === store &&
          !this.closing
        ) {
          try {
            this.denseCache.delete(cacheKey);
            this.denseCache.set(cacheKey, {
              version: after,
              expiresAt: performance.now() + denseCacheTtl,
              matches: structuredClone(matches),
            });
            while (this.denseCache.size > denseCacheLimit)
              this.denseCache.delete(this.denseCache.keys().next().value!);
          } catch {
            this.denseCache.delete(cacheKey);
          }
        }
      }
      return matches;
    }, signal);
  }

  private async runDenseScan<T>(
    scan: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    signal?.throwIfAborted();
    while (this.denseBusy) {
      if (this.denseWaiters >= 2 || !this.denseDone)
        throw new Error('Local semantic search is busy');
      this.denseWaiters++;
      try {
        await Promise.race([
          this.denseDone,
          delay(1000, undefined, { signal }),
        ]);
      } finally {
        this.denseWaiters--;
      }
      if (this.denseBusy) throw new Error('Local semantic search is busy');
    }
    this.denseBusy = true;
    let finish: () => void = () => undefined;
    this.denseDone = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      return await scan();
    } finally {
      this.denseBusy = false;
      finish();
      this.denseDone = undefined;
    }
  }

  async search(
    query: string,
    filters: SmartFilters,
    language?: string,
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted();
    if (!this.enabled()) return [];
    const store = await this.open().catch((error) => {
      this.retrievalWarning = String(error);
      return undefined;
    });
    const densePromise = (async () => {
      if (!store) return [];
      await withDeadline(this.startEngine(), 2000);
      signal?.throwIfAborted();
      const [vector] = await this.engine.embed(
        [query.replace(/\s+/gu, ' ').trim()],
        signal ?? AbortSignal.timeout(3000),
        3000
      );
      return this.searchDense(quantize(vector), filters, 500, signal);
    })();
    const lexicalPromise = store
      ? store.searchLexical(query, filters, 500)
      : Promise.resolve([]);
    const remotePromise = this.source.searchRelated
      ? withDeadline(this.source.searchRelated(query, filters, language))
      : Promise.resolve([]);
    const [denseResult, lexicalResult, remoteResult] = await Promise.allSettled(
      [densePromise, lexicalPromise, remotePromise]
    );
    signal?.throwIfAborted();
    const errors = [denseResult, lexicalResult, remoteResult].filter(
      (result) => result.status === 'rejected'
    );
    this.retrievalWarning = errors.length
      ? 'Some search sources are unavailable; showing available results.'
      : undefined;
    const dense = denseResult.status === 'fulfilled' ? denseResult.value : [];
    const lexical =
      lexicalResult.status === 'fulfilled' ? lexicalResult.value : [];
    const remote =
      remoteResult.status === 'fulfilled' ? remoteResult.value : [];
    try {
      const denseMatches = dense.map((item) => ({
        ...item,
        methods: ['semantic'] as SmartMatch['methods'],
      }));
      const remoteMatches = remote
        .filter((doc) => matchesFilters(doc, filters))
        .map((document) => ({
          document,
          score: 0,
          methods: ['tmdb-keyword'] as SmartMatch['methods'],
        }));
      const fused = fuseSmartCandidates(
        [denseMatches, lexical, remoteMatches],
        1000
      );
      // Reserve room for both strong dense candidates and high-ranked
      // on-demand metadata candidates; RRF alone over-rewards overlap and
      // can hide an older film that is not yet in the vector index.
      const protectedKeys = new Set(
        [...denseMatches.slice(0, 20), ...remoteMatches.slice(0, 5)].map(
          matchKey
        )
      );
      const protectedItems = fused.filter((item) =>
        protectedKeys.has(matchKey(item))
      );
      const extras = fused.filter((item) => !protectedKeys.has(matchKey(item)));
      const firstPageKeys = new Set(
        [
          ...protectedItems,
          ...extras.slice(0, searchShortlistSize - protectedItems.length),
        ].map(matchKey)
      );
      const audienceKeys = new Set(
        denseMatches
          .filter((item) => !firstPageKeys.has(matchKey(item)))
          .map((item) => ({
            item,
            rank:
              item.score +
              0.1 *
                Math.min(
                  1,
                  Math.log1p(Math.max(0, item.document.voteCount)) /
                    Math.log(10001)
                ),
          }))
          .sort((a, b) => b.rank - a.rank)
          .slice(0, 10)
          .map(({ item }) => matchKey(item))
      );
      const candidates = [
        ...fused.filter((item) => firstPageKeys.has(matchKey(item))),
        ...fused.filter((item) => audienceKeys.has(matchKey(item))),
        ...fused.filter(
          (item) =>
            !firstPageKeys.has(matchKey(item)) &&
            !audienceKeys.has(matchKey(item))
        ),
      ].slice(0, 100);
      // Very short searches often name concepts rather than describing the
      // desired work. Give the reranker the media-search context while leaving
      // longer natural-language requests unchanged.
      const wordCount = [...wordSegmenter.segment(query)].filter(
        (part) => part.isWordLike
      ).length;
      const rerankQuery =
        wordCount > 0 && wordCount <= 4 && Array.from(query).length <= 60
          ? `A film or series about ${query}`
          : query;
      const shortlist = searchRerankShortlist(
        candidates,
        denseMatches,
        wordCount,
        rerankLimit(maxRerankLimit)
      );
      const reranked = await this.rerank(
        rerankQuery,
        shortlist.candidates,
        shortlist.limit,
        6000,
        'search',
        signal
      );
      if (!reranked.some((item) => item.reranked)) {
        // The deeper audience-selected candidates are safe to promote only
        // after the reranker has assessed them. Keep the original retrieval
        // order when the model is disabled, busy, starting, or failed.
        return candidates
          .filter((item) => firstPageKeys.has(matchKey(item)))
          .slice(0, searchShortlistSize);
      }
      // Audience evidence only nudges a relevance ranking; it is capped so
      // unrated and less-known work remains eligible. These scores are ranks,
      // not calibrated probabilities.
      const ranked = reranked
        .map((item, order) => ({
          item,
          order,
          rank:
            item.score +
            0.03 *
              relevanceStrength(item.relevanceScore ?? 0) *
              Math.min(
                1,
                Math.log1p(Math.max(0, item.document.voteCount)) /
                  Math.log(5001)
              ) +
            0.004 *
              ratingEvidence(item.document) *
              relevanceStrength(item.relevanceScore ?? 0),
        }))
        .sort((a, b) => b.rank - a.rank || a.order - b.order)
        .map(({ item, rank }) => ({ ...item, score: rank }));
      return ranked.slice(0, searchShortlistSize);
    } finally {
      this.unloadWhenIdle();
    }
  }

  async indexedTitleCards(
    type: SmartMediaType,
    ids: string[],
    locale: string
  ): Promise<SmartDocument[]> {
    if (
      !this.enabled() ||
      !this.store ||
      this.source.id !== 'tmdb' ||
      !/^en(?:-us)?$/i.test(locale)
    )
      return [];
    return this.store.findDocuments('tmdb', type, ids);
  }

  private async seed(type: SmartMediaType, id: string) {
    if (!this.store) return undefined;
    let seed = await this.store.find(this.source.id, type, id);
    if (seed) {
      this.seedCache.delete(`${type}:${id}`);
      return seed;
    }
    const cached = this.seedCache.get(`${type}:${id}`);
    if (cached) return cached;
    try {
      if (!seed) {
        const [document] = await Promise.all([
          this.source.fetchOne(type, id, AbortSignal.timeout(2000)),
          this.startEngine(),
        ]);
        if (document) {
          const [embedding] = await this.engine.embed(
            [documentText(document)],
            AbortSignal.timeout(2000)
          );
          seed = { document, vector: quantize(embedding) };
          this.seedCache.set(`${type}:${id}`, seed);
          if (this.seedCache.size > 50)
            this.seedCache.delete(this.seedCache.keys().next().value!);
        }
      }
      return seed;
    } finally {
      this.unloadWhenIdle();
    }
  }

  async similar(
    type: SmartMediaType,
    id: string,
    filters: SmartFilters,
    language?: string
  ) {
    const applied = { ...filters, mediaType: filters.mediaType ?? type };
    const remotePromise = this.source.fetchRelated
      ? withDeadline(this.source.fetchRelated(type, id, language)).catch(
          () => []
        )
      : Promise.resolve([]);
    const seed =
      this.enabled() && this.store
        ? await withDeadline(this.seed(type, id), 2000).catch(() => undefined)
        : undefined;
    const local =
      seed && this.store
        ? await this.searchDense(seed.vector, applied, 250).catch(() => [])
        : [];
    const remote = (await remotePromise)
      .filter((doc) => matchesFilters(doc, applied))
      .slice(0, 24);
    let related: { doc: SmartDocument; score: number }[] = remote.map(
      (doc, index) => ({ doc, score: 1 - index / 100 })
    );
    const relatedScore = (doc: SmartDocument, similarity: number) =>
      similarity +
      (seed ? relatedPrior(seed.document, doc, similarity) : 0) +
      0.008 * ratingEvidence(doc) * relevanceStrength(similarity);
    if (seed && remote.length && this.engine.phase === 'ready') {
      try {
        // A stored vector is eligible only if the embedding input is
        // identical, including the overview language and genres.
        const indexed = await this.store
          ?.existing(
            this.source.id,
            type,
            remote.map((doc) => doc.sourceId)
          )
          .catch(() => undefined);
        const known = remote.map((doc) => {
          const entry =
            doc.source === this.source.id
              ? indexed?.get(doc.sourceId)
              : undefined;
          return entry?.hash === documentHash(doc) ? entry.vector : undefined;
        });
        const missing = remote.filter((_, index) => !known[index]);
        const embeddings = missing.length
          ? await this.engine.embed(
              missing.map(documentText),
              AbortSignal.timeout(1200)
            )
          : [];
        if (embeddings.length === missing.length) {
          let next = 0;
          related = remote
            .map((doc, index) => ({
              doc,
              score: relatedScore(
                doc,
                cosine(
                  seed.vector,
                  known[index] ?? quantize(embeddings[next++])
                )
              ),
            }))
            .sort((a, b) => b.score - a.score);
        }
      } catch {
        /* Local and TMDB ordering remain available if inference is busy. */
      }
    }
    const localMatches = local
      .map((item) => ({ item, rank: relatedScore(item.document, item.score) }))
      .sort((a, b) => b.rank - a.rank)
      .map(({ item }) => ({
        ...item,
        methods: ['semantic'] as SmartMatch['methods'],
      }));
    const remoteMatches = related.map(({ doc: document }) => ({
      document,
      score: 0,
      methods: ['tmdb-similar'] as SmartMatch['methods'],
    }));
    const candidates = fuseSmartCandidates(
      [localMatches, remoteMatches],
      80
    ).filter(
      (item) =>
        item.document.mediaType !== type || item.document.sourceId !== id
    );
    const query = seed
      ? `Find similar stories with a comparable plot, central conflict, themes and tone. ${documentText(seed.document)}`
      : '';
    if (!seed || !query) return candidates.slice(0, 30);
    const ranked = await this.rerank(query, candidates, 16, 2500, 'similar');
    return ranked
      .map((item, index) => ({
        item,
        // Reranked scores are fusions with more votes than the remaining
        // candidates. Use the final order to apply the same small priors.
        rank:
          4 / (40 + index + 1) -
          storyMatchPenalty(seed.document, item.document),
      }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 30)
      .map(({ item }) => ({
        ...item,
        seedTitle: seed.document.title,
        sharedGenreIds: item.document.genreIds.filter((id) =>
          seed.document.genreIds.includes(id)
        ),
      }));
  }

  async recommendations(
    seeds: { type: SmartMediaType; id: string }[],
    filters: SmartFilters,
    language?: string
  ) {
    if (!this.enabled()) return [];
    // The HTTP server can accept Discover requests before the startup
    // task opens the index. Join its in-progress open instead of reporting
    // that there are no recommendations.
    const store = await this.open().catch(() => undefined);
    if (!store) return [];
    const unique = [
      ...new Map(
        seeds.map((seed) => [`${seed.type}:${seed.id}`, seed])
      ).values(),
    ];
    const exclude = new Set(unique.map((item) => `${item.type}:${item.id}`));
    const sources = unique.slice(0, 3).map((item) => ({
      item,
      remote: this.source.fetchRelated
        ? withDeadline(
            this.source.fetchRelated(item.type, item.id, language)
          ).catch(() => [])
        : Promise.resolve([]),
    }));
    const pools: SmartMatch[][] = [];
    const seedsBySource = await Promise.all(
      sources.map(({ item }) =>
        this.seed(item.type, item.id).catch(() => undefined)
      )
    );
    const vectors = seedsBySource.flatMap((seed) =>
      seed ? [seed.vector] : []
    );
    const localPools =
      vectors.length > 1
        ? await this.runDenseScan(() =>
            store.searchMany(vectors, filters, 50)
          ).catch(() => [])
        : vectors.length === 1
          ? [await this.searchDense(vectors[0], filters, 50).catch(() => [])]
          : [];
    let localIndex = 0;
    for (const [index, { remote }] of sources.entries()) {
      const seed = seedsBySource[index];
      const local = seed ? (localPools[localIndex++] ?? []) : [];
      const related = await remote;
      const matches = fuseSmartCandidates(
        [
          local.map((match) => ({
            ...match,
            methods: ['semantic'],
          })),
          related
            .filter((doc) => matchesFilters(doc, filters))
            .map((document) => ({
              document,
              score: 0,
              methods: ['tmdb-recommendation'],
            })),
        ],
        50
      );
      pools.push(
        matches
          .filter(
            (match) =>
              !exclude.has(
                `${match.document.mediaType}:${match.document.sourceId}`
              )
          )
          .map((match) => ({
            ...match,
            seedTitle: seed?.document.title,
            sharedGenreIds: seed
              ? match.document.genreIds.filter((id) =>
                  seed.document.genreIds.includes(id)
                )
              : undefined,
          }))
      );
    }
    return balanceRecommendationPools(pools);
  }

  async close(): Promise<void> {
    this.clearRerankScores();
    this.clearDenseCache();
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.controller?.abort();
    this.runtimeController.abort();
    this.engine.stop();
    this.reranker.stop();
    if (this.rerankerIdle) clearTimeout(this.rerankerIdle);
    await this.inFlight;
    await this.opening?.catch(() => undefined);
    await this.store?.close();
    this.store = undefined;
  }
}
export default new SmartSearchService();
