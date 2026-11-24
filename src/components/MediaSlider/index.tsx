import ShowMoreCard from '@app/components/MediaSlider/ShowMoreCard';
import PersonCard from '@app/components/PersonCard';
import Slider from '@app/components/Slider';
import TitleCard from '@app/components/TitleCard';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import { ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import { MediaStatus } from '@server/constants/media';
import { Permission } from '@server/lib/permissions';
import type {
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import Link from 'next/link';
import { useEffect } from 'react';
import useSWRInfinite from 'swr/infinite';

interface MixedResult {
  page: number;
  totalResults: number;
  totalPages: number;
  results: (TvResult | MovieResult | PersonResult)[];
  basis?: 'requests' | 'library' | 'none';
}

interface MediaSliderProps {
  title: string;
  url: string;
  linkUrl?: string;
  sliderKey: string;
  hideWhenEmpty?: boolean;
  maxItems?: number;
  extraParams?: string;
  onNewTitles?: (titleCount: number) => void;
  emptyMessage?: (basis: MixedResult['basis']) => string;
  errorMessage?: string;
}

const MediaSlider = ({
  title,
  url,
  linkUrl,
  extraParams,
  sliderKey,
  hideWhenEmpty = false,
  maxItems = 20,
  onNewTitles,
  emptyMessage,
  errorMessage,
}: MediaSliderProps) => {
  const settings = useSettings();
  const { hasPermission } = useUser();
  const { data, error, setSize, size } = useSWRInfinite<MixedResult>(
    (pageIndex: number, previousPageData: MixedResult | null) => {
      if (previousPageData && pageIndex + 1 > previousPageData.totalPages) {
        return null;
      }

      return `${url}?page=${pageIndex + 1}${
        extraParams ? `&${extraParams}` : ''
      }`;
    },
    {
      initialSize: 2,
      revalidateFirstPage: false,
    }
  );

  let titles = (data ?? []).reduce(
    (a, v) => [...a, ...v.results],
    [] as (MovieResult | TvResult | PersonResult)[]
  );

  if (settings.currentSettings.hideAvailable) {
    titles = titles.filter(
      (i) =>
        !(i.mediaType === 'movie' || i.mediaType === 'tv') ||
        (i.mediaInfo?.status !== MediaStatus.AVAILABLE &&
          i.mediaInfo?.status !== MediaStatus.PARTIALLY_AVAILABLE)
    );
  }

  if (settings.currentSettings.hideBlocklisted) {
    titles = titles.filter(
      (i) =>
        !(i.mediaType === 'movie' || i.mediaType === 'tv') ||
        i.mediaInfo?.status !== MediaStatus.BLOCKLISTED
    );
  }

  if (settings.currentSettings.hideRequested) {
    titles = titles.filter((i) => {
      if (i.mediaType !== 'movie' && i.mediaType !== 'tv') {
        return true;
      }

      return !i.mediaInfo?.hasActiveRequest;
    });
  }

  useEffect(() => {
    if (
      titles.length < 24 &&
      size < 5 &&
      (data?.[0]?.totalResults ?? 0) > size * 20
    ) {
      setSize(size + 1);
    }

    if (onNewTitles) {
      // We aren't reporting all titles. We just want to know if there are any titles
      // at all for our purposes.
      onNewTitles(titles.length);
    }
  }, [titles, setSize, size, data, onNewTitles]);

  const blocklistVisibility = hasPermission(
    [Permission.MANAGE_BLOCKLIST, Permission.VIEW_BLOCKLIST],
    { type: 'or' }
  );

  const visibleTitles = titles.filter(
    (title) =>
      blocklistVisibility ||
      (title as TvResult | MovieResult).mediaInfo?.status !==
        MediaStatus.BLOCKLISTED
  );
  if (hideWhenEmpty && !visibleTitles.length) return null;

  const finalTitles = visibleTitles.slice(0, maxItems).map((title) => {
    switch (title.mediaType) {
      case 'movie':
        return (
          <TitleCard
            key={`${title.mediaType}:${title.id}`}
            id={title.id}
            isAddedToWatchlist={title.mediaInfo?.watchlists?.length ?? 0}
            image={title.posterPath}
            status={title.mediaInfo?.status}
            summary={title.overview}
            matchExplanation={title.matchExplanation}
            title={title.title}
            userScore={title.voteAverage}
            year={title.releaseDate}
            mediaType={title.mediaType}
            inProgress={(title.mediaInfo?.downloadStatus ?? []).length > 0}
          />
        );
      case 'tv':
        return (
          <TitleCard
            key={`${title.mediaType}:${title.id}`}
            id={title.id}
            isAddedToWatchlist={title.mediaInfo?.watchlists?.length ?? 0}
            image={title.posterPath}
            status={title.mediaInfo?.status}
            summary={title.overview}
            matchExplanation={title.matchExplanation}
            title={title.name}
            userScore={title.voteAverage}
            year={title.firstAirDate}
            mediaType={title.mediaType}
            inProgress={(title.mediaInfo?.downloadStatus ?? []).length > 0}
          />
        );
      case 'person':
        return (
          <PersonCard
            personId={title.id}
            name={title.name}
            profilePath={title.profilePath}
          />
        );
    }
  });

  if (linkUrl && visibleTitles.length > maxItems) {
    finalTitles.push(
      <ShowMoreCard
        url={linkUrl}
        posters={visibleTitles
          .slice(maxItems, maxItems + 4)
          .map((title) =>
            title.mediaType !== 'person' ? title.posterPath : undefined
          )}
      />
    );
  }

  return (
    <>
      <div className="slider-header">
        {linkUrl ? (
          <Link href={linkUrl} className="slider-title min-w-0 pr-16">
            <span className="truncate">{title}</span>
            <ArrowRightCircleIcon />
          </Link>
        ) : (
          <div className="slider-title">
            <span>{title}</span>
          </div>
        )}
      </div>
      <div
        className={
          emptyMessage ? 'min-h-[13.5rem] md:min-h-[16.5rem]' : undefined
        }
      >
        {error && !data && errorMessage ? (
          <p role="status" className="py-6 text-sm text-gray-400">
            {errorMessage}
          </p>
        ) : (
          <Slider
            sliderKey={sliderKey}
            isLoading={!data && !error}
            isEmpty={!!emptyMessage && !!data && finalTitles.length === 0}
            emptyMessage={emptyMessage?.(data?.[0]?.basis)}
            items={finalTitles}
          />
        )}
      </div>
    </>
  );
};

export default MediaSlider;
