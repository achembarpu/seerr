import Alert from '@app/components/Common/Alert';
import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover from '@app/hooks/useDiscover';
import useSettings from '@app/hooks/useSettings';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type {
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import SmartSearch from './SmartSearch';

const messages = defineMessages('components.Search', {
  search: 'Search',
  searchresults: 'Search Results',
  suggestions: 'Possible title matches',
  searchUnavailable:
    'Regular search is unavailable. You can still use smart search above.',
  imdbAttribution:
    'Information courtesy of IMDb (https://www.imdb.com). Used with permission.',
});

const Search = () => {
  const intl = useIntl();
  const router = useRouter();
  const settings = useSettings();

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
  } = useDiscover<MovieResult | TvResult | PersonResult>(
    `/api/v1/search`,
    {
      query: router.query.query,
    },
    { hideAvailable: false, hideBlocklisted: false, hideRequested: false }
  );

  const query =
    typeof router.query.query === 'string' ? router.query.query : '';
  const { data: suggestionsData } = useSWR<{
    results: (MovieResult | TvResult)[];
  }>(
    query.length >= 3
      ? `/api/v1/search/suggestions?query=${encodeURIComponent(query)}`
      : null,
    { revalidateOnFocus: false }
  );
  const visible = new Set(
    titles.map((title) => `${title.mediaType}:${title.id}`)
  );
  const suggestions = (suggestionsData?.results ?? []).filter(
    (title) => !visible.has(`${title.mediaType}:${title.id}`)
  );

  if (error && !settings.currentSettings.smartSearch) {
    return <ErrorPage statusCode={500} />;
  }

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.search)} />
      {settings.currentSettings.smartSearch && <SmartSearch query={query} />}
      {suggestions.length > 0 && (
        <>
          <div className="mb-5 mt-1">
            <Header>{intl.formatMessage(messages.suggestions)}</Header>
          </div>
          <p className="mb-3 text-sm text-gray-400">
            {intl.formatMessage(messages.imdbAttribution)}
          </p>
          <ListView
            items={suggestions}
            isEmpty={false}
            isLoading={false}
            isReachingEnd
            onScrollBottom={() => undefined}
          />
        </>
      )}
      <div className="mb-5 mt-1">
        <Header>{intl.formatMessage(messages.searchresults)}</Header>
      </div>
      {error ? (
        <Alert type="warning">
          {intl.formatMessage(messages.searchUnavailable)}
        </Alert>
      ) : (
        <ListView
          items={titles}
          isEmpty={isEmpty && suggestions.length === 0}
          isLoading={
            isLoadingInitialData || (isLoadingMore && (titles?.length ?? 0) > 0)
          }
          isReachingEnd={isReachingEnd}
          onScrollBottom={fetchMore}
        />
      )}
    </>
  );
};

export default Search;
