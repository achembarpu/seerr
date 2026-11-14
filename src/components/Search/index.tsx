import Alert from '@app/components/Common/Alert';
import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover from '@app/hooks/useDiscover';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import type {
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import SmartSearch, { emptySearchFilters } from './SmartSearch';
import { mergeResults, type SearchItem } from './mergeResults';
import { serializeSmartSearchParams } from './smartSearchQuery';

const messages = defineMessages('components.Search', {
  search: 'Search',
  searchresults: 'Search Results',
  searchUnavailable: 'Some search results are temporarily unavailable.',
  smartLoading: 'Description search is still starting or indexing.',
  imdbAttribution:
    'Information courtesy of IMDb (https://www.imdb.com). Used with permission.',
});

const Search = () => {
  const intl = useIntl();
  const router = useRouter();
  const settings = useSettings();
  const [filters, setFilters] = useState(emptySearchFilters);
  const query =
    typeof router.query.query === 'string' ? router.query.query : '';
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 500);
    return () => clearTimeout(timer);
  }, [query]);
  const {
    isLoadingInitialData,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
  } = useDiscover<MovieResult | TvResult | PersonResult>(
    '/api/v1/search',
    { query: router.query.query },
    { hideAvailable: false, hideBlocklisted: false, hideRequested: false }
  );
  const {
    data: suggestions,
    error: suggestionError,
    isLoading: suggestionsLoading,
  } = useSWR<{ results: SearchItem[] }>(
    Array.from(debouncedQuery.trim()).length >= 2 && debouncedQuery === query
      ? `/api/v1/search/suggestions?query=${encodeURIComponent(debouncedQuery)}`
      : null,
    { revalidateOnFocus: false }
  );
  const params = new URLSearchParams({ query: debouncedQuery });
  for (const [key, value] of Object.entries({
    mediaType: filters.type === 'person' ? '' : filters.type,
    originalLanguage: filters.language,
    yearFrom: filters.yearFrom,
    yearTo: filters.yearTo,
    minRating: filters.rating,
    minVotes: filters.votes,
    genre: filters.genre,
  }))
    if (value) params.set(key, value);
  const {
    data: smart,
    error: smartError,
    isLoading: smartLoading,
  } = useSWR<{ ready: boolean; results: SearchItem[] }>(
    settings.currentSettings.smartSearch &&
      debouncedQuery.trim() &&
      debouncedQuery === query &&
      filters.type !== 'person'
      ? `/api/v1/search/smart?${serializeSmartSearchParams(params)}`
      : null,
    { revalidateOnFocus: false }
  );
  const items = mergeResults(
    query,
    titles,
    suggestions?.results ?? [],
    smart?.results ?? [],
    filters
  );
  const loading =
    isLoadingInitialData ||
    suggestionsLoading ||
    smartLoading ||
    debouncedQuery !== query;
  return (
    <>
      <PageTitle title={intl.formatMessage(messages.search)} />
      <div className="mb-5 mt-1">
        <Header>{intl.formatMessage(messages.searchresults)}</Header>
      </div>
      <SmartSearch filters={filters} setFilters={setFilters} />
      {(error || suggestionError || smartError) && (
        <Alert type="warning">
          {intl.formatMessage(messages.searchUnavailable)}
        </Alert>
      )}
      {smart && !smart.ready && (
        <p className="mb-3 text-sm text-gray-400">
          {intl.formatMessage(messages.smartLoading)}
        </p>
      )}
      <ListView
        items={items}
        isEmpty={!loading && items.length === 0}
        isLoading={loading || isLoadingMore}
        isReachingEnd={isReachingEnd && !loading}
        onScrollBottom={fetchMore}
      />
      {!!suggestions?.results.length && (
        <p className="mt-4 text-sm text-gray-400">
          {intl.formatMessage(messages.imdbAttribution)}
        </p>
      )}
    </>
  );
};
export default Search;
