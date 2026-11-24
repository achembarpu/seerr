import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover from '@app/hooks/useDiscover';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { TvResult } from '@server/models/Search';
import type { TvDetails } from '@server/models/Tv';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.TvDetails', {
  moreLikeThis: 'More like this',
});

const TvSimilar = () => {
  const router = useRouter();
  const intl = useIntl();
  const { data: tvData } = useSWR<TvDetails>(`/api/v1/tv/${router.query.tvId}`);
  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
  } = useDiscover<TvResult>(
    '/api/v1/search/smart/similar',
    { mediaType: 'tv', id: router.query.tvId },
    { initialSize: 1 }
  );

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  return (
    <>
      <PageTitle
        title={[intl.formatMessage(messages.moreLikeThis), tvData?.name]}
      />
      <div className="mb-5 mt-1">
        <Header
          subtext={
            <Link href={`/tv/${tvData?.id}`} className="hover:underline">
              {tvData?.name}
            </Link>
          }
        >
          {intl.formatMessage(messages.moreLikeThis)}
        </Header>
      </div>
      <ListView
        items={titles}
        isEmpty={isEmpty}
        isReachingEnd={isReachingEnd}
        isLoading={
          isLoadingInitialData || (isLoadingMore && (titles?.length ?? 0) > 0)
        }
        onScrollBottom={fetchMore}
      />
    </>
  );
};

export default TvSimilar;
