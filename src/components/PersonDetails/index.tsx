import Ellipsis from '@app/assets/ellipsis.svg';
import CachedImage from '@app/components/Common/CachedImage';
import ImageFader from '@app/components/Common/ImageFader';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import ExternalLinkBlock from '@app/components/ExternalLinkBlock';
import TitleCard from '@app/components/TitleCard';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { BarsArrowDownIcon, CircleStackIcon } from '@heroicons/react/24/solid';
import type { PersonCombinedCreditsResponse } from '@server/interfaces/api/personInterfaces';
import type { PersonDetails as PersonDetailsType } from '@server/models/Person';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import TruncateMarkup from 'react-truncate-markup';
import useSWR from 'swr';
import { rankCredits, type CreditMediaType, type CreditSort } from './credits';

const messages = defineMessages('components.PersonDetails', {
  birthdate: 'Born {birthdate}',
  lifespan: '{birthdate} – {deathdate}',
  alsoknownas: 'Also Known As: {names}',
  appearsin: 'Appearances',
  crewmember: 'Crew',
  ascharacter: 'as {character}',
  creditMediaType: 'Credit type',
  creditSort: 'Sort credits',
  topCredits: 'Top credits',
  newestCredits: 'Newest first',
});

const PersonDetails = () => {
  const intl = useIntl();
  const router = useRouter();
  const [currentMediaType, setCurrentMediaType] =
    useState<CreditMediaType>('all');
  const [creditSort, setCreditSort] = useState<CreditSort>('top');
  const { data, error } = useSWR<PersonDetailsType>(
    `/api/v1/person/${router.query.personId}`
  );
  const [showBio, setShowBio] = useState(false);

  const { data: combinedCredits, error: errorCombinedCredits } =
    useSWR<PersonCombinedCreditsResponse>(
      `/api/v1/person/${router.query.personId}/combined_credits`
    );

  const sortedCast = useMemo(
    () =>
      rankCredits(
        combinedCredits?.cast ?? [],
        currentMediaType,
        creditSort,
        (credit) => credit.character
      ),
    [combinedCredits?.cast, currentMediaType, creditSort]
  );

  const sortedCrew = useMemo(
    () =>
      rankCredits(
        combinedCredits?.crew ?? [],
        currentMediaType,
        creditSort,
        (credit) => credit.job,
        data?.knownForDepartment
      ),
    [
      combinedCredits?.crew,
      currentMediaType,
      creditSort,
      data?.knownForDepartment,
    ]
  );

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={404} />;
  }

  const personAttributes: string[] = [];

  if (data.birthday) {
    if (data.deathday) {
      personAttributes.push(
        intl.formatMessage(messages.lifespan, {
          birthdate: intl.formatDate(data.birthday, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC',
          }),
          deathdate: intl.formatDate(data.deathday, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC',
          }),
        })
      );
    } else {
      personAttributes.push(
        intl.formatMessage(messages.birthdate, {
          birthdate: intl.formatDate(data.birthday, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC',
          }),
        })
      );
    }
  }

  if (data.placeOfBirth) {
    personAttributes.push(data.placeOfBirth);
  }

  const isLoading = !combinedCredits && !errorCombinedCredits;

  const creditControls = (
    <div className="mb-2 flex flex-wrap justify-center gap-2 lg:mb-0 lg:justify-end">
      <div className="flex">
        <span className="inline-flex items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100">
          <CircleStackIcon className="h-5 w-5" />
        </span>
        <select
          aria-label={intl.formatMessage(messages.creditMediaType)}
          onChange={(e) =>
            setCurrentMediaType(e.target.value as CreditMediaType)
          }
          value={currentMediaType}
          className="rounded-r-only"
        >
          <option value="all">{intl.formatMessage(globalMessages.all)}</option>
          <option value="movie">
            {intl.formatMessage(globalMessages.movies)}
          </option>
          <option value="tv">
            {intl.formatMessage(globalMessages.tvshows)}
          </option>
        </select>
      </div>
      <div className="flex">
        <span className="inline-flex items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100">
          <BarsArrowDownIcon className="h-5 w-5" />
        </span>
        <select
          aria-label={intl.formatMessage(messages.creditSort)}
          onChange={(e) => setCreditSort(e.target.value as CreditSort)}
          value={creditSort}
          className="rounded-r-only"
        >
          <option value="top">{intl.formatMessage(messages.topCredits)}</option>
          <option value="newest">
            {intl.formatMessage(messages.newestCredits)}
          </option>
        </select>
      </div>
    </div>
  );

  const cast = (sortedCast ?? []).length > 0 && (
    <>
      <div className="slider-header">
        <div className="slider-title">
          <span>{intl.formatMessage(messages.appearsin)}</span>
        </div>
      </div>
      <ul className="cards-vertical">
        {sortedCast.map((media) => {
          return (
            <li key={`list-cast-item-${media.mediaType}-${media.id}`}>
              <TitleCard
                key={media.id}
                id={media.id}
                title={media.mediaType === 'movie' ? media.title : media.name}
                userScore={media.voteAverage}
                year={
                  media.mediaType === 'movie'
                    ? media.releaseDate
                    : media.firstAirDate
                }
                image={media.posterPath}
                summary={media.overview}
                mediaType={media.mediaType}
                status={media.mediaInfo?.status}
                canExpand
              />
              {media.roles && (
                <div className="mt-2 w-full truncate text-center text-xs text-gray-300">
                  {intl.formatMessage(messages.ascharacter, {
                    character: media.roles,
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );

  const crew = (sortedCrew ?? []).length > 0 && (
    <>
      <div className="slider-header">
        <div className="slider-title">
          <span>{intl.formatMessage(messages.crewmember)}</span>
        </div>
      </div>
      <ul className="cards-vertical">
        {sortedCrew.map((media) => {
          return (
            <li key={`list-crew-item-${media.mediaType}-${media.id}`}>
              <TitleCard
                key={media.id}
                id={media.id}
                title={media.mediaType === 'movie' ? media.title : media.name}
                userScore={media.voteAverage}
                year={
                  media.mediaType === 'movie'
                    ? media.releaseDate
                    : media.firstAirDate
                }
                image={media.posterPath}
                summary={media.overview}
                mediaType={media.mediaType}
                status={media.mediaInfo?.status}
                canExpand
              />
              {media.roles && (
                <div className="mt-2 w-full truncate text-center text-xs text-gray-300">
                  {media.roles}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );

  return (
    <>
      <PageTitle title={data.name} />
      {(sortedCrew || sortedCast) && (
        <div className="absolute left-0 right-0 top-0 z-0 h-96">
          <ImageFader
            isDarker
            backgroundImages={[...(sortedCast ?? []), ...(sortedCrew ?? [])]
              .filter((media) => media.backdropPath)
              .slice(0, 6)
              .map(
                (media) =>
                  `https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${media.backdropPath}`
              )}
          />
        </div>
      )}
      <div
        className={`relative z-10 mb-8 mt-4 flex flex-col items-center lg:flex-row ${
          data.biography ? 'lg:items-start' : ''
        }`}
      >
        {data.profilePath && (
          <div className="relative mb-6 mr-0 h-36 w-36 flex-shrink-0 overflow-hidden rounded-full ring-1 ring-gray-700 lg:mb-0 lg:mr-6 lg:h-44 lg:w-44">
            <CachedImage
              type="tmdb"
              src={`https://image.tmdb.org/t/p/w600_and_h900_bestv2${data.profilePath}`}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              fill
            />
          </div>
        )}
        <div className="w-full text-center text-gray-300 lg:text-left">
          <div className="flex w-full items-center justify-center lg:justify-between">
            <h1 className="text-3xl text-white lg:text-4xl">{data.name}</h1>
            <div className="hidden flex-shrink-0 lg:block">
              {creditControls}
            </div>
          </div>
          <div className="flex w-full items-center justify-center lg:justify-between">
            <div className="mb-3 mt-3">
              <ExternalLinkBlock
                mediaType="person"
                tmdbId={data.id}
                imdbId={data.imdbId}
              />
            </div>
          </div>
          <div className="mb-2 mt-1 space-y-1 text-xs text-white sm:text-sm lg:text-base">
            <div>{personAttributes.join(' | ')}</div>
            {(data.alsoKnownAs ?? []).length > 0 && (
              <div>
                {intl.formatMessage(messages.alsoknownas, {
                  names: (data.alsoKnownAs ?? []).reduce((prev, curr) =>
                    intl.formatMessage(globalMessages.delimitedlist, {
                      a: prev,
                      b: curr,
                    })
                  ),
                })}
              </div>
            )}
          </div>
          <div className="lg:hidden">{creditControls}</div>
          {data.biography && (
            <div className="relative text-left">
              {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events */}
              <div
                className="group outline-none ring-0"
                onClick={() => setShowBio((show) => !show)}
                role="button"
                tabIndex={-1}
              >
                <TruncateMarkup
                  lines={showBio ? 200 : 6}
                  ellipsis={
                    <Ellipsis className="relative -top-0.5 ml-2 inline-block opacity-70 transition duration-300 group-hover:opacity-100" />
                  }
                >
                  <p className="pt-2 text-sm lg:text-base">{data.biography}</p>
                </TruncateMarkup>
              </div>
            </div>
          )}
        </div>
      </div>
      {data.knownForDepartment === 'Acting' ? [cast, crew] : [crew, cast]}
      {isLoading && <LoadingSpinner />}
    </>
  );
};

export default PersonDetails;
