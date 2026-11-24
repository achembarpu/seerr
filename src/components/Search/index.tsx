import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover from '@app/hooks/useDiscover';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import { MediaStatus } from '@server/constants/media';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import SmartSearch, {
  emptySearchFilters,
  type SearchFilters,
} from './SmartSearch';
import { serializeSmartSearchParams } from './smartSearchQuery';
import {
  isDirectLookup,
  mergeSearchResults,
  rankTitleResults,
  type SearchItem,
} from './titleResults';

const messages = defineMessages('components.Search', {
  search: 'Search',
  searchresults: 'Search Results',
  matches: 'Matches',
  moreMatches: 'Show more matches',
  fewerResults: 'Show fewer',
  smartSearch: 'Smart search',
  noTitleMatches: 'No matching titles.',
  noSmartMatches: 'No matches found.',
  titleUnavailable: 'Some title matches are temporarily unavailable.',
  descriptionUnavailable: 'Description search is temporarily unavailable.',
  smartLoading: 'The search index is still getting ready.',
  smartSearching: 'Searching descriptions…',
  imdbAttribution:
    'Information courtesy of IMDb (https://www.imdb.com). Used with permission.',
});

const resultsPerPage = 20;
const smartResultLimit = 25;

const ResultControls = ({
  moreLabel,
  onMore,
  onFewer,
  isLoading,
}: {
  moreLabel: string;
  onMore?: () => void;
  onFewer?: () => void;
  isLoading?: boolean;
}) => {
  const intl = useIntl();
  const primary = useRef<HTMLButtonElement>(null);
  if (!onMore && !onFewer) return null;

  const fewerLabel = intl.formatMessage(messages.fewerResults);
  const collapse = () => {
    onFewer?.();
    // Return to the controls after the removed rows leave the layout.
    requestAnimationFrame(() => {
      primary.current?.focus({ preventScroll: true });
      primary.current?.scrollIntoView({ block: 'nearest' });
    });
  };

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <Button
        ref={primary}
        buttonType="ghost"
        buttonSize="sm"
        onClick={onMore ?? collapse}
        disabled={!!onMore && isLoading}
      >
        {onMore ? <ChevronDownIcon /> : <ChevronUpIcon />}
        <span>{onMore ? moreLabel : fewerLabel}</span>
      </Button>
      {onMore && onFewer && (
        <Button buttonType="ghost" buttonSize="sm" onClick={collapse}>
          <ChevronUpIcon />
          <span>{fewerLabel}</span>
        </Button>
      )}
    </div>
  );
};

const supportsSemanticSearch = (query: string, filters: SearchFilters) =>
  !isDirectLookup(query) && filters.type !== 'person';

const SearchResults = ({
  query,
  filters,
  smartEnabled,
}: {
  query: string;
  filters: SearchFilters;
  smartEnabled: boolean;
}) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const [matchLimit, setMatchLimit] = useState(resultsPerPage);
  const directLookup = isDirectLookup(query);

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
  const descriptionKey = smartEnabled
    ? `/api/v1/search/smart?${serializeSmartSearchParams(params)}`
    : null;
  const [descriptionResponse, setDescriptionResponse] = useState<{
    key: string;
    data?: { ready: boolean; results: SearchItem[] };
    error?: true;
  }>();
  const readyKey = descriptionResponse?.data?.ready
    ? descriptionResponse.key
    : undefined;
  useEffect(() => {
    if (!descriptionKey || descriptionKey === readyKey) return;
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
  }, [descriptionKey, readyKey]);
  const latest =
    descriptionResponse?.key === descriptionKey
      ? descriptionResponse
      : undefined;
  const smart = latest?.data;
  const smartError = latest?.error;
  const smartLoading = smartEnabled && !latest;

  const descriptions = visible(smart?.results ?? []);
  const matches = descriptions.length
    ? mergeSearchResults(ranked, descriptions, filters)
    : ranked.map(({ item }) => item);
  const shownTitles = matches.slice(
    0,
    smartEnabled ? smartResultLimit : matchLimit
  );
  const hasMoreTitlePages = !isReachingEnd && !!firstResultData;
  const showMoreMatches = () => {
    const nextLimit = matchLimit + resultsPerPage;
    setMatchLimit(nextLimit);
    if (nextLimit > ranked.length && hasMoreTitlePages) fetchMore();
  };

  return (
    <section aria-labelledby="title-matches">
      <div className="slider-header flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 id="title-matches" className="slider-title">
          {intl.formatMessage(messages.matches)}
        </h3>
        {smartLoading && (
          <p
            role="status"
            className="inline-flex items-center gap-2 text-sm text-gray-400"
          >
            <ArrowPathIcon
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {intl.formatMessage(messages.smartSearching)}
          </p>
        )}
      </div>
      {(error || fuzzyError) && (
        <Alert type="warning">
          {intl.formatMessage(messages.titleUnavailable)}
        </Alert>
      )}
      {smartError && (
        <Alert type="warning">
          {intl.formatMessage(messages.descriptionUnavailable)}
        </Alert>
      )}
      {smart && !smart.ready && descriptions.length === 0 && (
        <p role="status" className="mb-3 text-sm text-gray-400">
          {intl.formatMessage(messages.smartLoading)}
        </p>
      )}
      {!shownTitles.length && !titlesLoading && !smartLoading && (
        <p className="text-sm text-gray-400">
          {intl.formatMessage(
            smartEnabled ? messages.noSmartMatches : messages.noTitleMatches
          )}
        </p>
      )}
      <ListView
        items={shownTitles}
        stableItemKeys
        placeholderCount={6}
        isLoading={!shownTitles.length && titlesLoading}
      />
      {!smartEnabled && (
        <ResultControls
          moreLabel={intl.formatMessage(messages.moreMatches)}
          onMore={
            ranked.length > shownTitles.length || hasMoreTitlePages
              ? showMoreMatches
              : undefined
          }
          onFewer={
            matchLimit > resultsPerPage
              ? () => setMatchLimit(resultsPerPage)
              : undefined
          }
          isLoading={isLoadingMore}
        />
      )}
      {!!fuzzy?.results.length && (
        <p className="mt-4 text-xs text-gray-400">
          {intl.formatMessage(messages.imdbAttribution)}
        </p>
      )}
    </section>
  );
};

const Search = () => {
  const intl = useIntl();
  const router = useRouter();
  const settings = useSettings();
  const [filters, setFilters] = useState(emptySearchFilters);
  const [smartSearch, setSmartSearch] = useState(false);
  const query =
    typeof router.query.query === 'string' ? router.query.query.trim() : '';
  const canSearchDescriptions =
    settings.currentSettings.smartSearch &&
    supportsSemanticSearch(query, filters);
  const smartEnabled = smartSearch && canSearchDescriptions;
  return (
    <>
      <PageTitle title={intl.formatMessage(messages.search)} />
      <div className="mb-5 mt-1">
        <Header>{intl.formatMessage(messages.searchresults)}</Header>
      </div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <SmartSearch filters={filters} setFilters={setFilters} />
        {settings.currentSettings.smartSearch && (
          <Button
            type="button"
            buttonType={smartEnabled ? 'primary' : 'default'}
            aria-pressed={smartEnabled}
            disabled={!canSearchDescriptions}
            onClick={() => setSmartSearch((enabled) => !enabled)}
          >
            <SparklesIcon aria-hidden="true" />
            <span>{intl.formatMessage(messages.smartSearch)}</span>
          </Button>
        )}
      </div>
      {query && (
        <SearchResults
          key={query}
          query={query}
          filters={filters}
          smartEnabled={smartEnabled}
        />
      )}
    </>
  );
};
export default Search;
