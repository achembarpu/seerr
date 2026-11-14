import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import SlideOver from '@app/components/Common/SlideOver';
import LanguageSelector from '@app/components/LanguageSelector';
import defineMessages from '@app/utils/defineMessages';
import { FunnelIcon, XCircleIcon } from '@heroicons/react/24/solid';
import type { MovieResult, TvResult } from '@server/models/Search';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import { serializeSmartSearchParams } from './smartSearchQuery';

const messages = defineMessages('components.Search.SmartSearch', {
  open: 'Smart search',
  close: 'Close smart search',
  title: 'Smart discovery',
  tip: 'Find movies and series by their description. Results improve as the local index builds.',
  type: 'Type',
  all: 'Movies and series',
  movie: 'Movies',
  tv: 'Series',
  language: 'Original Language',
  filters: 'Filters',
  activeFilters:
    '{count, plural, one {# Active Filter} other {# Active Filters}}',
  clearFilters: 'Clear Active Filters',
  releaseYear: 'Release Year',
  from: 'From',
  to: 'To',
  rating: 'Minimum rating (0–10)',
  votes: 'Minimum votes',
  genre: 'Genre',
  anyGenre: 'Any genre',
  loading: 'The smart index is still starting or downloading.',
  error: 'Unable to search the local index.',
  recommendations: 'Recommended from your requests',
  recommendationsTip: 'Based on your recent requests and your filters.',
});
const genres = [
  [28, 'Action'],
  [12, 'Adventure'],
  [16, 'Animation'],
  [35, 'Comedy'],
  [80, 'Crime'],
  [99, 'Documentary'],
  [18, 'Drama'],
  [10751, 'Family'],
  [14, 'Fantasy'],
  [36, 'History'],
  [27, 'Horror'],
  [10402, 'Music'],
  [9648, 'Mystery'],
  [10749, 'Romance'],
  [878, 'Science fiction'],
  [53, 'Thriller'],
  [10752, 'War'],
  [37, 'Western'],
  [10759, 'Action and adventure (TV)'],
  [10762, 'Kids (TV)'],
  [10763, 'News (TV)'],
  [10764, 'Reality (TV)'],
  [10765, 'Science fiction and fantasy (TV)'],
  [10766, 'Soap (TV)'],
  [10767, 'Talk (TV)'],
  [10768, 'War and politics (TV)'],
] as const;

const SmartSearch = ({ query }: { query: string }) => {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [type, setType] = useState('');
  const [language, setLanguage] = useState('');
  const [yearFrom, setYearFrom] = useState('');
  const [yearTo, setYearTo] = useState('');
  const [rating, setRating] = useState('');
  const [votes, setVotes] = useState('');
  const [genre, setGenre] = useState('');
  const activeFilters = [
    type,
    language,
    yearFrom,
    yearTo,
    rating,
    votes,
    genre,
  ].filter(Boolean).length;
  const params = new URLSearchParams({ query });
  for (const [key, value] of Object.entries({
    mediaType: type,
    originalLanguage: language,
    yearFrom,
    yearTo,
    minRating: rating,
    minVotes: votes,
    genre,
  }))
    if (value) params.set(key, value);
  const serializedParams = serializeSmartSearchParams(params);
  const [debouncedParams, setDebouncedParams] = useState(serializedParams);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedParams(serializedParams), 500);
    return () => clearTimeout(timer);
  }, [serializedParams]);
  const recommendationParams = new URLSearchParams(debouncedParams);
  recommendationParams.delete('query');
  const { data: recommendations } = useSWR<{
    results: (MovieResult | TvResult)[];
  }>(
    open
      ? `/api/v1/search/smart/recommendations?${serializeSmartSearchParams(recommendationParams)}`
      : null,
    { revalidateOnFocus: false }
  );
  const { data, error, isLoading } = useSWR<{
    enabled: boolean;
    ready: boolean;
    results: (MovieResult | TvResult)[];
  }>(open && query.trim() ? `/api/v1/search/smart?${debouncedParams}` : null, {
    revalidateOnFocus: false,
  });
  return (
    <div className="mb-6">
      <Button type="button" buttonSize="sm" onClick={() => setOpen(!open)}>
        {intl.formatMessage(open ? messages.close : messages.open)}
      </Button>
      {open && (
        <div className="mt-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <Header>{intl.formatMessage(messages.title)}</Header>
              <p className="mt-2 text-sm text-gray-400">
                {intl.formatMessage(messages.tip)}
              </p>
            </div>
            <Button type="button" onClick={() => setShowFilters(true)}>
              <FunnelIcon />
              <span>
                {intl.formatMessage(messages.activeFilters, {
                  count: activeFilters,
                })}
              </span>
            </Button>
          </div>
          <SlideOver
            show={showFilters}
            title={intl.formatMessage(messages.filters)}
            subText={intl.formatMessage(messages.activeFilters, {
              count: activeFilters,
            })}
            onClose={() => setShowFilters(false)}
          >
            <div className="flex flex-col space-y-5">
              <div>
                <label
                  htmlFor="smart-media-type"
                  className="mb-2 block text-lg font-semibold"
                >
                  {intl.formatMessage(messages.type)}
                </label>
                <select
                  id="smart-media-type"
                  value={type}
                  onChange={(event) => setType(event.target.value)}
                >
                  <option value="">{intl.formatMessage(messages.all)}</option>
                  <option value="movie">
                    {intl.formatMessage(messages.movie)}
                  </option>
                  <option value="tv">{intl.formatMessage(messages.tv)}</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="smart-genre"
                  className="mb-2 block text-lg font-semibold"
                >
                  {intl.formatMessage(messages.genre)}
                </label>
                <select
                  id="smart-genre"
                  value={genre}
                  onChange={(event) => setGenre(event.target.value)}
                >
                  <option value="">
                    {intl.formatMessage(messages.anyGenre)}
                  </option>
                  {genres.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="mb-2 text-lg font-semibold">
                  {intl.formatMessage(messages.language)}
                </div>
                <LanguageSelector
                  value={language}
                  setFieldValue={(_field, value) =>
                    setLanguage(value.split('|').filter(Boolean).at(-1) ?? '')
                  }
                />
              </div>
              <div>
                <div className="mb-2 text-lg font-semibold">
                  {intl.formatMessage(messages.releaseYear)}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-sm text-gray-300">
                    {intl.formatMessage(messages.from)}
                    <input
                      className="mt-2 block w-full rounded-md border border-gray-500 bg-gray-700 text-white sm:text-sm"
                      type="number"
                      min="1870"
                      max="2200"
                      value={yearFrom}
                      onChange={(event) => setYearFrom(event.target.value)}
                    />
                  </label>
                  <label className="text-sm text-gray-300">
                    {intl.formatMessage(messages.to)}
                    <input
                      className="mt-2 block w-full rounded-md border border-gray-500 bg-gray-700 text-white sm:text-sm"
                      type="number"
                      min="1870"
                      max="2200"
                      value={yearTo}
                      onChange={(event) => setYearTo(event.target.value)}
                    />
                  </label>
                </div>
              </div>
              <div>
                <label
                  htmlFor="smart-rating"
                  className="mb-2 block text-lg font-semibold"
                >
                  {intl.formatMessage(messages.rating)}
                </label>
                <input
                  id="smart-rating"
                  className="block w-full rounded-md border border-gray-500 bg-gray-700 text-white sm:text-sm"
                  type="number"
                  min="0"
                  max="10"
                  step="0.1"
                  value={rating}
                  onChange={(event) => setRating(event.target.value)}
                />
              </div>
              <div>
                <label
                  htmlFor="smart-votes"
                  className="mb-2 block text-lg font-semibold"
                >
                  {intl.formatMessage(messages.votes)}
                </label>
                <input
                  id="smart-votes"
                  className="block w-full rounded-md border border-gray-500 bg-gray-700 text-white sm:text-sm"
                  type="number"
                  min="0"
                  value={votes}
                  onChange={(event) => setVotes(event.target.value)}
                />
              </div>
              {activeFilters > 0 && (
                <Button
                  type="button"
                  onClick={() => {
                    setType('');
                    setGenre('');
                    setLanguage('');
                    setYearFrom('');
                    setYearTo('');
                    setRating('');
                    setVotes('');
                  }}
                >
                  <XCircleIcon />
                  <span>{intl.formatMessage(messages.clearFilters)}</span>
                </Button>
              )}
            </div>
          </SlideOver>
          {isLoading && !data && <SmallLoadingSpinner />}
          {data && !data.ready && (
            <p className="text-sm text-gray-400">
              {intl.formatMessage(messages.loading)}
            </p>
          )}
          {error && (
            <p className="text-sm text-red-400">
              {intl.formatMessage(messages.error)}
            </p>
          )}
          {data?.ready && (
            <ListView
              items={data.results}
              isEmpty={data.results.length === 0}
              isLoading={isLoading}
              isReachingEnd
              onScrollBottom={() => undefined}
            />
          )}
          {!!recommendations?.results.length && (
            <div className="mt-6">
              <Header>{intl.formatMessage(messages.recommendations)}</Header>
              <p className="mb-3 mt-2 text-sm text-gray-400">
                {intl.formatMessage(messages.recommendationsTip)}
              </p>
              <ListView
                items={recommendations.results}
                isEmpty={false}
                isLoading={false}
                isReachingEnd
                onScrollBottom={() => undefined}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
export default SmartSearch;
