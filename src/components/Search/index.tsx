import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover from '@app/hooks/useDiscover';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { MediaStatus } from '@server/constants/media';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import SmartSearch, {
  emptySearchFilters,
  type SearchFilters,
} from './SmartSearch';
import { serializeSmartSearchParams } from './smartSearchQuery';
import {
  descriptionResults,
  isDirectLookup,
  rankTitleResults,
  type SearchItem,
} from './titleResults';

const messages = defineMessages('components.Search', {
  search: 'Search',
  searchresults: 'Search Results',
  titleMatches: 'Title matches',
  descriptionMatches: 'Matches by description',
  searchDescriptions: 'Search descriptions',
  hideDescriptions: 'Hide description matches',
  moreTitles: 'Load more title matches',
  noTitleMatches: 'No matching titles.',
  noDescriptionMatches: 'No additional matches by description.',
  titleUnavailable: 'Some title matches are temporarily unavailable.',
  descriptionUnavailable: 'Description search is temporarily unavailable.',
  smartLoading: 'Description search is still starting or indexing.',
  smartSearching: 'Searching descriptions…',
  imdbAttribution:
    'Information courtesy of IMDb (https://www.imdb.com). Used with permission.',
});

const SearchResults = ({
  query,
  filters,
}: {
  query: string;
  filters: SearchFilters;
}) => {
  const intl = useIntl();
  const settings = useSettings();
  const { hasPermission } = useUser();
  const [requestedDescriptions, setRequestedDescriptions] = useState(false);
  const [settled, setSettled] = useState(false);
  const [titleDeadline, setTitleDeadline] = useState(false);
  const directLookup = isDirectLookup(query);
  const canSearchDescriptions =
    settings.currentSettings.smartSearch &&
    !directLookup &&
    filters.type !== 'person';
  useEffect(() => {
    if (!canSearchDescriptions) return;
    const settle = setTimeout(() => setSettled(true), 400);
    const deadline = setTimeout(() => setTitleDeadline(true), 900);
    return () => {
      clearTimeout(settle);
      clearTimeout(deadline);
    };
  }, [canSearchDescriptions]);

  const {
    firstResultData,
    isLoadingInitialData,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
  } = useDiscover<SearchItem>(
    '/api/v1/search',
    { query },
    {
      hideAvailable: false,
      hideBlocklisted: false,
      hideRequested: false,
      initialSize: 1,
    }
  );
  const {
    data: fuzzy,
    error: fuzzyError,
    isLoading: fuzzyLoading,
  } = useSWR<{
    results: SearchItem[];
  }>(
    !directLookup && filters.type !== 'person' && Array.from(query).length >= 2
      ? `/api/v1/search/suggestions?query=${encodeURIComponent(query)}`
      : null,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const canViewBlocklisted = hasPermission(
    [Permission.MANAGE_BLOCKLIST, Permission.VIEW_BLOCKLIST],
    { type: 'or' }
  );
  const visible = (items: SearchItem[]) =>
    items.filter(
      (item) =>
        canViewBlocklisted ||
        item.mediaType === 'person' ||
        item.mediaInfo?.status !== MediaStatus.BLOCKLISTED
    );
  const ranked = rankTitleResults(
    query,
    visible(titles),
    visible(fuzzy?.results ?? []),
    filters
  );
  const titlesLoading =
    (isLoadingInitialData && !firstResultData) || fuzzyLoading;
  const searchDescriptions =
    canSearchDescriptions &&
    (requestedDescriptions ||
      (!ranked.confident && settled && (!titlesLoading || titleDeadline)));
  const params = new URLSearchParams({ query });
  for (const [key, value] of Object.entries({
    mediaType: filters.type,
    originalLanguage: filters.language,
    yearFrom: filters.yearFrom,
    yearTo: filters.yearTo,
    minRating: filters.rating,
    minVotes: filters.votes,
    genre: filters.genre,
  }))
    if (value) params.set(key, value);
  const descriptionKey = searchDescriptions
    ? `/api/v1/search/smart?${serializeSmartSearchParams(params)}`
    : null;
  const [descriptionResponse, setDescriptionResponse] = useState<{
    key: string;
    data?: { ready: boolean; results: SearchItem[] };
    error?: true;
  }>();
  useEffect(() => {
    if (!descriptionKey) return;
    const controller = new AbortController();
    axios
      .get<{ ready: boolean; results: SearchItem[] }>(descriptionKey, {
        signal: controller.signal,
      })
      .then(
        ({ data }) => {
          if (!controller.signal.aborted)
            setDescriptionResponse({ key: descriptionKey, data });
        },
        () => {
          if (!controller.signal.aborted)
            setDescriptionResponse({ key: descriptionKey, error: true });
        }
      );
    return () => controller.abort();
  }, [descriptionKey]);
  const latest =
    descriptionResponse?.key === descriptionKey
      ? descriptionResponse
      : undefined;
  const smart = latest?.data;
  const smartError = latest?.error;
  const smartLoading = !!descriptionKey && !latest;

  const descriptionsFirst = canSearchDescriptions && !ranked.confident;
  const descriptionHasMatches = !!smart?.results.length;
  const shownTitles =
    descriptionsFirst && (!smart || descriptionHasMatches) && !smartError
      ? ranked.credible
      : ranked.all;
  const descriptions = descriptionResults(
    visible(smart?.results ?? []),
    shownTitles,
    filters
  );
  const titleSection = (!descriptionsFirst ||
    !descriptions.length ||
    !!shownTitles.length) && (
    <section key="titles" aria-labelledby="title-matches">
      <div className="slider-header flex-wrap items-center justify-between gap-2">
        <h3 id="title-matches" className="slider-title">
          {intl.formatMessage(messages.titleMatches)}
        </h3>
        {canSearchDescriptions && ranked.confident && (
          <Button
            buttonType="ghost"
            buttonSize="sm"
            aria-expanded={requestedDescriptions}
            onClick={() => setRequestedDescriptions(!requestedDescriptions)}
          >
            {intl.formatMessage(
              requestedDescriptions
                ? messages.hideDescriptions
                : messages.searchDescriptions
            )}
          </Button>
        )}
      </div>
      {(error || fuzzyError) && (
        <Alert type="warning">
          {intl.formatMessage(messages.titleUnavailable)}
        </Alert>
      )}
      {!shownTitles.length && !titlesLoading && (
        <p className="text-sm text-gray-400">
          {intl.formatMessage(messages.noTitleMatches)}
        </p>
      )}
      <ListView
        items={shownTitles}
        stableItemKeys
        placeholderCount={6}
        isLoading={!shownTitles.length && titlesLoading}
      />
      {!isReachingEnd && firstResultData && (
        <Button
          className="mt-4"
          buttonType="ghost"
          buttonSize="sm"
          disabled={isLoadingMore}
          onClick={fetchMore}
        >
          {intl.formatMessage(messages.moreTitles)}
        </Button>
      )}
      {!!fuzzy?.results.length && (
        <p className="mt-4 text-xs text-gray-400">
          {intl.formatMessage(messages.imdbAttribution)}
        </p>
      )}
    </section>
  );
  const descriptionSection = searchDescriptions && (
    <section key="descriptions" aria-labelledby="description-matches">
      <div className="slider-header">
        <h3 id="description-matches" className="slider-title">
          {intl.formatMessage(messages.descriptionMatches)}
        </h3>
      </div>
      {smartLoading && (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-gray-400"
        >
          <ArrowPathIcon
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          {intl.formatMessage(messages.smartSearching)}
        </p>
      )}
      {smartError && (
        <Alert type="warning">
          {intl.formatMessage(messages.descriptionUnavailable)}
        </Alert>
      )}
      {smart && !descriptions.length && (
        <p role="status" className="text-sm text-gray-400">
          {intl.formatMessage(
            smart.ready ? messages.noDescriptionMatches : messages.smartLoading
          )}
        </p>
      )}
      {!!descriptions.length && (
        <ListView items={descriptions} stableItemKeys />
      )}
    </section>
  );
  return (
    <div className="space-y-8">
      {descriptionsFirst
        ? [descriptionSection, titleSection]
        : [titleSection, descriptionSection]}
    </div>
  );
};

const Search = () => {
  const intl = useIntl();
  const router = useRouter();
  const [filters, setFilters] = useState(emptySearchFilters);
  const query =
    typeof router.query.query === 'string' ? router.query.query.trim() : '';
  return (
    <>
      <PageTitle title={intl.formatMessage(messages.search)} />
      <div className="mb-5 mt-1">
        <Header>{intl.formatMessage(messages.searchresults)}</Header>
      </div>
      <SmartSearch filters={filters} setFilters={setFilters} />
      {query && <SearchResults key={query} query={query} filters={filters} />}
    </>
  );
};
export default Search;
