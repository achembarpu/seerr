import Button from '@app/components/Common/Button';
import SlideOver from '@app/components/Common/SlideOver';
import LanguageSelector from '@app/components/LanguageSelector';
import { genres } from '@app/i18n/mediaGenres';
import defineMessages from '@app/utils/defineMessages';
import { FunnelIcon, XCircleIcon } from '@heroicons/react/24/solid';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Search.SmartSearch', {
  type: 'Type',
  allResults: 'All results',
  person: 'People',
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
});
export interface SearchFilters {
  type: string;
  language: string;
  yearFrom: string;
  yearTo: string;
  rating: string;
  votes: string;
  genre: string;
}

export const emptySearchFilters: SearchFilters = {
  type: '',
  language: '',
  yearFrom: '',
  yearTo: '',
  rating: '',
  votes: '',
  genre: '',
};

const SmartSearch = ({
  filters,
  setFilters,
}: {
  filters: SearchFilters;
  setFilters: (filters: SearchFilters) => void;
}) => {
  const intl = useIntl();
  const [showFilters, setShowFilters] = useState(false);
  const { type, language, yearFrom, yearTo, rating, votes, genre } = filters;
  const setType = (type: string) => setFilters({ ...filters, type });
  const setLanguage = (language: string) =>
    setFilters({ ...filters, language });
  const setYearFrom = (yearFrom: string) =>
    setFilters({ ...filters, yearFrom });
  const setYearTo = (yearTo: string) => setFilters({ ...filters, yearTo });
  const setRating = (rating: string) => setFilters({ ...filters, rating });
  const setVotes = (votes: string) => setFilters({ ...filters, votes });
  const setGenre = (genre: string) => setFilters({ ...filters, genre });
  const activeFilters = [
    type,
    language,
    yearFrom,
    yearTo,
    rating,
    votes,
    genre,
  ].filter(Boolean).length;
  return (
    <>
      <Button type="button" onClick={() => setShowFilters(true)}>
        <FunnelIcon />
        <span>
          {intl.formatMessage(messages.activeFilters, { count: activeFilters })}
        </span>
      </Button>
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
              <option value="">
                {intl.formatMessage(messages.allResults)}
              </option>
              <option value="movie">
                {intl.formatMessage(messages.movie)}
              </option>
              <option value="tv">{intl.formatMessage(messages.tv)}</option>
              <option value="person">
                {intl.formatMessage(messages.person)}
              </option>
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
              <option value="">{intl.formatMessage(messages.anyGenre)}</option>
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
              onClick={() => setFilters(emptySearchFilters)}
            >
              <XCircleIcon />
              <span>{intl.formatMessage(messages.clearFilters)}</span>
            </Button>
          )}
        </div>
      </SlideOver>
    </>
  );
};
export default SmartSearch;
