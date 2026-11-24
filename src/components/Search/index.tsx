import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover from '@app/hooks/useDiscover';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { ArrowPathIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
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
  matches: 'Matches',
  descriptionMatches: 'Suggestions',
  moreMatches: 'Show more matches',
  moreSuggestions: 'Show more suggestions',
  searchMode: 'Search mode',
  automatic: 'Automatic',
  titlesOnly: 'Titles only',
  titlesAndSemantic: 'Titles + semantic',
  noTitleMatches: 'No matching titles.',
  noDescriptionMatches: 'No suggestions found.',
  titleUnavailable: 'Some title matches are temporarily unavailable.',
  descriptionUnavailable: 'Suggestions are temporarily unavailable.',
  smartLoading: 'The search index is still getting ready.',
  smartSearching: 'Finding suggestions…',
  imdbAttribution:
    'Information courtesy of IMDb (https://www.imdb.com). Used with permission.',
});

const words = new Intl.Segmenter(undefined, { granularity: 'word' });
const resultsPerPage = 20;

type SearchMode = 'automatic' | 'titles' | 'semantic';

const supportsSemanticSearch = (query: string, filters: SearchFilters) =>
  !isDirectLookup(query) && filters.type !== 'person';

const SearchResults = ({
  query,
  filters,
  mode,
}: {
  query: string;
  filters: SearchFilters;
  mode: SearchMode;
}) => {
  const intl = useIntl();
  const settings = useSettings();
  const { hasPermission } = useUser();
  const [settled, setSettled] = useState(false);
  const [titleDeadline, setTitleDeadline] = useState(false);
  const [matchLimit, setMatchLimit] = useState(resultsPerPage);
  const [suggestionLimit, setSuggestionLimit] = useState(resultsPerPage);
  const directLookup = isDirectLookup(query);
  const longQuery =
    [...words.segment(query)].filter((word) => word.isWordLike).length >= 6;
  const canSearchDescriptions =
    settings.currentSettings.smartSearch &&
    supportsSemanticSearch(query, filters);
  useEffect(() => {
    if (!canSearchDescriptions) return;
    const settle = setTimeout(() => setSettled(true), 450);
    const deadline = setTimeout(() => setTitleDeadline(true), 750);
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
  const showSuggestions =
    canSearchDescriptions &&
    mode !== 'titles' &&
    (mode === 'semantic' || !ranked.confident);
  const searchDescriptions =
    showSuggestions &&
    settled &&
    (mode === 'semantic' || longQuery || !titlesLoading || titleDeadline);
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
        {(ranked.all.length > shownTitles.length || hasMoreTitlePages) && (
          <Button
            className="mt-4"
            buttonType="ghost"
            buttonSize="sm"
            disabled={isLoadingMore}
            onClick={showMoreMatches}
          >
            <ChevronDownIcon />
            <span>{intl.formatMessage(messages.moreMatches)}</span>
          </Button>
        )}
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
              items={descriptions.slice(0, suggestionLimit)}
              stableItemKeys
            />
          )}
          {descriptions.length > suggestionLimit && (
            <Button
              className="mt-4"
              buttonType="ghost"
              buttonSize="sm"
              onClick={() =>
                setSuggestionLimit(suggestionLimit + resultsPerPage)
              }
            >
              <ChevronDownIcon />
              <span>{intl.formatMessage(messages.moreSuggestions)}</span>
            </Button>
          )}
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
  const [mode, setMode] = useState<SearchMode>('automatic');
  const query =
    typeof router.query.query === 'string' ? router.query.query.trim() : '';
  return (
    <>
      <PageTitle title={intl.formatMessage(messages.search)} />
      <div className="mb-5 mt-1">
        <Header>{intl.formatMessage(messages.searchresults)}</Header>
      </div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <SmartSearch filters={filters} setFilters={setFilters} />
        {settings.currentSettings.smartSearch && (
          <label className="flex items-center gap-2 text-sm text-gray-300">
            {intl.formatMessage(messages.searchMode)}
            <select
              value={supportsSemanticSearch(query, filters) ? mode : 'titles'}
              disabled={!supportsSemanticSearch(query, filters)}
              onChange={(event) => setMode(event.target.value as SearchMode)}
            >
              <option value="automatic">
                {intl.formatMessage(messages.automatic)}
              </option>
              <option value="titles">
                {intl.formatMessage(messages.titlesOnly)}
              </option>
              <option value="semantic">
                {intl.formatMessage(messages.titlesAndSemantic)}
              </option>
            </select>
          </label>
        )}
      </div>
      {query && (
        <SearchResults
          key={query}
          query={query}
          filters={filters}
          mode={mode}
        />
      )}
    </>
  );
};
export default Search;
