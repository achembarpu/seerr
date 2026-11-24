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
  descriptionResults,
  isDirectLookup,
  rankTitleResults,
  type SearchItem,
} from './titleResults';

const messages = defineMessages('components.Search', {
  search: 'Search',
  searchresults: 'Search Results',
  matches: 'Matches',
  descriptionMatches: 'Suggestions',
  moreMatches: 'Show more matches',
  moreSuggestions: 'Show more suggestions',
  fewerResults: 'Show fewer',
  smartSearch: 'Smart search',
  noTitleMatches: 'No matching titles.',
  noDescriptionMatches: 'No suggestions found.',
  titleUnavailable: 'Some title matches are temporarily unavailable.',
  descriptionUnavailable: 'Suggestions are temporarily unavailable.',
  smartLoading: 'The search index is still getting ready.',
  smartSearching: 'Finding suggestions…',
  imdbAttribution:
    'Information courtesy of IMDb (https://www.imdb.com). Used with permission.',
});

const resultsPerPage = 20;

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
  showSuggestions,
}: {
  query: string;
  filters: SearchFilters;
  showSuggestions: boolean;
}) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const [settled, setSettled] = useState(false);
  const [matchLimit, setMatchLimit] = useState(resultsPerPage);
  const [suggestionsExpanded, setSuggestionsExpanded] = useState(false);
  const directLookup = isDirectLookup(query);
  useEffect(() => {
    const settle = setTimeout(() => setSettled(true), 450);
    return () => clearTimeout(settle);
  }, []);

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
  const descriptionKey =
    showSuggestions && settled
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
  const smartLoading = showSuggestions && !latest;

  const matches =
    showSuggestions &&
    !ranked.confident &&
    matchLimit === resultsPerPage &&
    !smartError &&
    (!smart || smart.results.length > 0)
      ? ranked.credible
      : ranked.all;
  const shownTitles = matches.slice(0, matchLimit);
  const descriptions = descriptionResults(
    visible(smart?.results ?? []),
    shownTitles,
    filters
  );
  const hasMoreTitlePages = !isReachingEnd && !!firstResultData;
  const showMoreMatches = () => {
    const nextLimit = matchLimit + resultsPerPage;
    setMatchLimit(nextLimit);
    if (nextLimit > ranked.all.length && hasMoreTitlePages) fetchMore();
  };

  return (
    <div className="space-y-8">
      <section aria-labelledby="title-matches">
        <div className="slider-header flex-wrap items-center justify-between gap-2">
          <h3 id="title-matches" className="slider-title">
            {intl.formatMessage(messages.matches)}
          </h3>
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
        <ResultControls
          moreLabel={intl.formatMessage(messages.moreMatches)}
          onMore={
            ranked.all.length > shownTitles.length || hasMoreTitlePages
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
        {!!fuzzy?.results.length && (
          <p className="mt-4 text-xs text-gray-400">
            {intl.formatMessage(messages.imdbAttribution)}
          </p>
        )}
      </section>
      {showSuggestions && (
        <section aria-labelledby="description-matches">
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
                smart.ready
                  ? messages.noDescriptionMatches
                  : messages.smartLoading
              )}
            </p>
          )}
          {!!descriptions.length && (
            <ListView
              items={
                suggestionsExpanded
                  ? descriptions
                  : descriptions.slice(0, resultsPerPage)
              }
              stableItemKeys
            />
          )}
          <ResultControls
            moreLabel={intl.formatMessage(messages.moreSuggestions)}
            onMore={
              !suggestionsExpanded && descriptions.length > resultsPerPage
                ? () => setSuggestionsExpanded(true)
                : undefined
            }
            onFewer={
              suggestionsExpanded
                ? () => setSuggestionsExpanded(false)
                : undefined
            }
          />
        </section>
      )}
    </div>
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
  const showSuggestions = smartSearch && canSearchDescriptions;
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
            buttonType={showSuggestions ? 'primary' : 'default'}
            aria-pressed={showSuggestions}
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
          showSuggestions={showSuggestions}
        />
      )}
    </>
  );
};
export default Search;
