import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import defineMessages from '@app/utils/defineMessages';
import type { MovieResult, TvResult } from '@server/models/Search';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Search.SmartSearch', {
  open: 'Smart search',
  close: 'Close smart search',
  title: 'Smart discovery',
  tip: 'Find movies and series by their description. Results improve as the local index builds.',
  type: 'Type',
  all: 'Movies and series',
  movie: 'Movies',
  tv: 'Series',
  language: 'Original language code',
  yearFrom: 'From year',
  yearTo: 'To year',
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
  const [type, setType] = useState('');
  const [language, setLanguage] = useState('');
  const [yearFrom, setYearFrom] = useState('');
  const [yearTo, setYearTo] = useState('');
  const [rating, setRating] = useState('');
  const [votes, setVotes] = useState('');
  const [genre, setGenre] = useState('');
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
  const serializedParams = params.toString();
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
      ? `/api/v1/search/smart/recommendations?${recommendationParams}`
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
          <Header>{intl.formatMessage(messages.title)}</Header>
          <p className="mb-3 mt-2 text-sm text-gray-400">
            {intl.formatMessage(messages.tip)}
          </p>
          <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
            <label className="text-sm">
              {intl.formatMessage(messages.type)}
              <select
                className="form-input mt-1 w-full"
                value={type}
                onChange={(event) => setType(event.target.value)}
              >
                <option value="">{intl.formatMessage(messages.all)}</option>
                <option value="movie">
                  {intl.formatMessage(messages.movie)}
                </option>
                <option value="tv">{intl.formatMessage(messages.tv)}</option>
              </select>
            </label>
            <label className="text-sm">
              {intl.formatMessage(messages.genre)}
              <select
                className="form-input mt-1 w-full"
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
            </label>
            <label className="text-sm">
              {intl.formatMessage(messages.language)}
              <input
                className="form-input mt-1 w-full"
                value={language}
                maxLength={20}
                onChange={(event) => setLanguage(event.target.value)}
              />
            </label>
            <label className="text-sm">
              {intl.formatMessage(messages.yearFrom)}
              <input
                className="form-input mt-1 w-full"
                type="number"
                min="1870"
                max="2200"
                value={yearFrom}
                onChange={(event) => setYearFrom(event.target.value)}
              />
            </label>
            <label className="text-sm">
              {intl.formatMessage(messages.yearTo)}
              <input
                className="form-input mt-1 w-full"
                type="number"
                min="1870"
                max="2200"
                value={yearTo}
                onChange={(event) => setYearTo(event.target.value)}
              />
            </label>
            <label className="text-sm">
              {intl.formatMessage(messages.rating)}
              <input
                className="form-input mt-1 w-full"
                type="number"
                min="0"
                max="10"
                step="0.1"
                value={rating}
                onChange={(event) => setRating(event.target.value)}
              />
            </label>
            <label className="text-sm">
              {intl.formatMessage(messages.votes)}
              <input
                className="form-input mt-1 w-full"
                type="number"
                min="0"
                value={votes}
                onChange={(event) => setVotes(event.target.value)}
              />
            </label>
          </div>
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
