import type { TmdbSearchMultiResponse } from '@server/api/themoviedb/interfaces';
import { searchMedia } from '@server/lib/mediaSearch';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

type Result = TmdbSearchMultiResponse['results'][number];
const movie = (title: string, id = 1): Result =>
  ({ media_type: 'movie', id, title, original_title: title }) as Result;
const response = (results: Result[], page = 1): TmdbSearchMultiResponse => ({
  page,
  total_pages: results.length ? 2 : 0,
  total_results: results.length,
  results,
});

describe('media search', () => {
  it('preserves normal TMDB results and pagination', async () => {
    const calls: string[] = [];
    const search = async ({ query, page }: { query: string; page: number }) => {
      calls.push(`${query}:${page}`);
      return response([movie('The Matrix')], page);
    };
    const result = await searchMedia({ search, query: 'matrix', page: 2 });
    assert.deepEqual(calls, ['matrix:1', 'matrix:2']);
    assert.equal(result.page, 2);
  });

  it('retries a misspelled title and ranks close matches first', async () => {
    const calls: string[] = [];
    const search = async ({
      query,
      page,
      language,
    }: {
      query: string;
      page: number;
      language?: string;
    }) => {
      calls.push(`${query}:${page}:${language}`);
      return query === 'matr'
        ? response([movie('The Matriarch', 2), movie('The Matrix')], page)
        : response([], page);
    };
    const result = await searchMedia({
      search,
      query: 'the matrx',
      page: 1,
      language: 'en-US',
    });
    assert.equal(result.results[0].id, 1);
    assert.ok(calls.includes('matr:1:en-US'));
    assert.equal(result.total_pages, 2);
  });

  it('matches a single misspelled word within a longer title', async () => {
    const search = async ({ query, page }: { query: string; page: number }) =>
      query === 'matr'
        ? response([movie('The Matrix')], page)
        : response([], page);
    const result = await searchMedia({ search, query: 'matrx', page: 1 });
    assert.equal(result.results[0].id, 1);
  });

  it('uses the same fallback query for later pages', async () => {
    const calls: string[] = [];
    const search = async ({ query, page }: { query: string; page: number }) => {
      calls.push(`${query}:${page}`);
      return query === 'breaking'
        ? response([movie('Breaking Bad')], page)
        : response([], page);
    };
    const result = await searchMedia({
      search,
      query: 'breaking bda',
      page: 2,
    });
    assert.equal(result.page, 2);
    assert.equal(calls.at(-1), 'breaking:2');
  });

  it('does not return unrelated fallback results', async () => {
    const search = async ({ query, page }: { query: string; page: number }) =>
      query === 'unicorn'
        ? response([], page)
        : response([movie('Completely Different')], page);
    const result = await searchMedia({ search, query: 'unicorn', page: 1 });
    assert.deepEqual(result.results, []);
  });
});
