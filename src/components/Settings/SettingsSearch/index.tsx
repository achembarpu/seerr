import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import type { SearchIndexStatus } from '@server/lib/searchIndex/service';
import type { MainSettings } from '@server/lib/settings';
import type { SmartSearchService } from '@server/lib/smartSearch/service';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import type { ChangeEvent } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';
import { indexProgress } from './indexProgress';

type SmartStatus = ReturnType<SmartSearchService['status']> & {
  popularCursor?: { type: 'movie' | 'tv'; page: number; totalPages?: number };
  lexical?: {
    indexed: number;
    total: number;
    indexing: boolean;
    error?: string;
  };
  reranker?: {
    enabled: boolean;
    phase: string;
    downloadBytes: number;
    downloadTotal: number;
    activeDevice?: string;
    error?: string;
  };
};

const messages = defineMessages('components.Settings.SettingsMain', {
  localTitleSearch: 'Local typo-tolerant title search',
  localTitleSearchTip:
    'Download and refresh TMDB and IMDb title indexes in the background. IMDb permits a personal movie database for individual personal, non-commercial use, subject to its terms. Save settings to apply.',
  localTitleSearchTerms: 'IMDb terms',
  searchIndexImdb: 'IMDb titles',
  searchIndexRatings: 'IMDb ratings',
  searchIndexMovies: 'TMDB movies',
  searchIndexTv: 'TMDB series',
  searchIndexUpdating: 'Updating',
  searchIndexWaiting: 'Waiting for first download',
  searchIndexReady: 'Ready',
  searchIndexFailed: 'Update failed; retry scheduled',
  searchIndexFailedManual: 'Update failed; use Refresh now to retry',
  searchIndexNext: 'Next update: {date}',
  searchIndexChecked: 'Last checked: {date}',
  searchIndexRefresh: 'Refresh now',
  searchIndexRefreshFailed: 'Could not start the search index refresh.',
  searchIndexStatusFailed: 'Could not load the search index status.',
  smartSearch: 'Local smart search',
  smartSearchTip:
    'Download a 119 MB embedding model and build a local TMDB discovery index in the background. The index uses additional disk space and CPU. Save settings to apply.',
  smartSearchStatus: 'Status: {phase}; indexed titles: {count}',
  smartSearchDevice: 'Smart search inference device',
  smartSearchDeviceTip:
    'Choose a detected GPU or CPU. Automatic uses a GPU when available and falls back to CPU. The host inference service handles embeddings; reranking uses a local device.',
  smartSearchDeviceAuto: 'Automatic',
  smartSearchDeviceCpu: 'CPU',
  smartSearchDeviceHost: 'Host inference service (for example, macOS Metal)',
  smartSearchActiveDevice: 'Active inference device: {device}',
  smartSearchDownload: 'Downloading model: {percent}%',
  smartSearchProgress: 'Indexing {mediaType} from {year}, page {page}',
  smartSearchRefreshFailed: 'Could not start smart search refresh.',

  searchSettings: 'Search',
  searchSettingsTitle: 'Search Settings',
  searchSettingsDescription: 'Configure local search, indexing and inference.',
  saveSuccess: 'Search settings saved successfully.',
  saveError: 'Unable to save search settings.',
  loadError: 'Unable to load search settings.',
  smartStatusError: 'Could not load smart search status.',
  indexUpdating: 'Updating the description index',
  indexAvailable: 'Description index is available',
  indexWaiting: 'Waiting for indexed descriptions',
  indexCoverageTip:
    'Search is available while indexing continues. Coverage grows as titles are processed.',
  lexicalProgress: 'Keyword index: {indexed} of {total} indexed descriptions',
  lexicalUpdating: 'Updating keyword index',
  popularProgress: 'Prioritizing popular {mediaType}, page {page}',
  popularPaused: 'Popular {mediaType} indexing paused at page {page}',
  popularPausedTotal:
    'Popular {mediaType} indexing paused at page {page} of {total}',
  popularProgressTotal:
    'Prioritizing popular {mediaType}, page {page} of {total}',
  popularMovies: 'movies',
  popularSeries: 'series',
  scanProgressDetailed: 'Indexing {mediaType} from {period}, page {page}',
  scanPausedDetailed: 'Indexing paused at {period}, {mediaType}, page {page}',
  rerank: 'Improve relevance with local reranking',
  rerankTip:
    'Download a separate 396 MB multilingual model when needed to refine search and similar-title results. It requires additional inference memory.',
  rerankStatus: 'Reranker: {phase}',
  rerankCandidates: 'Candidates to rerank',
  rerankCandidatesTip:
    'More candidates can improve coverage but take more time and inference resources.',
  rerank20: '20 — faster',
  rerank40: '40 — balanced',
  rerank80: '80 — more thorough',
  titleRefreshInterval: 'Title index refresh schedule',
  titleRefreshIntervalTip:
    'Daily and weekly check for title updates automatically. Manual only uses the current index until Refresh now is pressed.',
  smartRefreshInterval: 'Description index refresh schedule',
  smartRefreshIntervalTip:
    'Daily and weekly run the initial scan and check for updates automatically. Manual only requires Refresh now to start or resume indexing and to check for updates.',
  refreshDaily: 'Daily',
  refreshWeekly: 'Weekly',
  refreshManual: 'Manual only',
});

const SettingsSearch = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<MainSettings>('/api/v1/settings/main');
  const {
    data: searchIndexStatus,
    error: searchIndexError,
    mutate: refreshSearchIndexStatus,
  } = useSWR<SearchIndexStatus>(data ? '/api/v1/settings/search-index' : null, {
    refreshInterval: (status) => (status?.refreshing ? 3000 : 30000),
    revalidateOnFocus: false,
  });
  const {
    data: smartStatus,
    error: smartStatusError,
    mutate: refreshSmartStatus,
  } = useSWR<SmartStatus>(data ? '/api/v1/settings/smart-search' : null, {
    refreshInterval: 3000,
    revalidateOnFocus: false,
  });
  const sourceLabels = {
    imdb: messages.searchIndexImdb,
    'imdb-ratings': messages.searchIndexRatings,
    'tmdb-movie': messages.searchIndexMovies,
    'tmdb-tv': messages.searchIndexTv,
  } as const;

  const progress = smartStatus ? indexProgress(smartStatus) : undefined;

  if (!data && !error) return <LoadingSpinner />;
  if (!data)
    return (
      <p className="text-red-400">{intl.formatMessage(messages.loadError)}</p>
    );
  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.searchSettings),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.searchSettingsTitle)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.searchSettingsDescription)}
        </p>
      </div>
      <div className="section">
        <Formik
          initialValues={{
            localTitleSearch: data.localTitleSearch,
            localTitleSearchRefreshInterval:
              data.localTitleSearchRefreshInterval ?? 'daily',
            smartSearch: data.smartSearch,
            smartSearchRerank: data.smartSearchRerank ?? false,
            smartSearchRerankCandidates: data.smartSearchRerankCandidates ?? 40,
            smartSearchRefreshInterval:
              data.smartSearchRefreshInterval ?? 'daily',
            smartSearchDevice: data.smartSearchDevice || 'auto',
          }}
          enableReinitialize
          onSubmit={async (values) => {
            try {
              await axios.post('/api/v1/settings/main', values);
              await Promise.all([
                revalidate(),
                mutate('/api/v1/settings/public'),
                refreshSearchIndexStatus(),
                refreshSmartStatus(),
              ]);
              addToast(intl.formatMessage(messages.saveSuccess), {
                autoDismiss: true,
                appearance: 'success',
              });
            } catch {
              addToast(intl.formatMessage(messages.saveError), {
                autoDismiss: true,
                appearance: 'error',
              });
            }
          }}
        >
          {({ values, setFieldValue, isSubmitting, dirty }) => (
            <Form className="section" data-testid="settings-search-form">
              <div className="form-row">
                <label htmlFor="localTitleSearch" className="checkbox-label">
                  {intl.formatMessage(messages.localTitleSearch)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.localTitleSearchTip)}{' '}
                    <a
                      href="https://help.imdb.com/article/imdb/general-information/can-i-use-imdb-data-in-my-software/G5JTRESSHJBBHTGX"
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      {intl.formatMessage(messages.localTitleSearchTerms)}
                    </a>
                  </span>
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id="localTitleSearch"
                    name="localTitleSearch"
                    onChange={() =>
                      setFieldValue(
                        'localTitleSearch',
                        !values.localTitleSearch
                      )
                    }
                  />
                </div>
              </div>
              {values.localTitleSearch && (
                <div className="form-row">
                  <label
                    htmlFor="localTitleSearchRefreshInterval"
                    className="text-label"
                  >
                    {intl.formatMessage(messages.titleRefreshInterval)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.titleRefreshIntervalTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      as="select"
                      id="localTitleSearchRefreshInterval"
                      name="localTitleSearchRefreshInterval"
                    >
                      <option value="daily">
                        {intl.formatMessage(messages.refreshDaily)}
                      </option>
                      <option value="weekly">
                        {intl.formatMessage(messages.refreshWeekly)}
                      </option>
                      <option value="manual">
                        {intl.formatMessage(messages.refreshManual)}
                      </option>
                    </Field>
                  </div>
                </div>
              )}
              {data?.localTitleSearch && (
                <div className="form-row">
                  <div className="form-input-area">
                    {searchIndexError && (
                      <p className="text-sm text-red-400">
                        {intl.formatMessage(messages.searchIndexStatusFailed)}
                      </p>
                    )}
                    {searchIndexStatus && (
                      <>
                        {Object.entries(sourceLabels).map(([source, label]) => {
                          const key = source as keyof typeof sourceLabels;
                          const sourceStatus = searchIndexStatus.sources[key];
                          const status =
                            searchIndexStatus.currentSource === key
                              ? messages.searchIndexUpdating
                              : searchIndexStatus.failedSources.includes(key)
                                ? data.localTitleSearchRefreshInterval ===
                                  'manual'
                                  ? messages.searchIndexFailedManual
                                  : messages.searchIndexFailed
                                : sourceStatus.available
                                  ? messages.searchIndexReady
                                  : messages.searchIndexWaiting;
                          return (
                            <p key={key} className="mb-1 text-sm text-gray-300">
                              {intl.formatMessage(label)}:{' '}
                              {intl.formatMessage(status)}
                              {sourceStatus.lastChecked && (
                                <>
                                  {' '}
                                  ·{' '}
                                  {intl.formatMessage(
                                    messages.searchIndexChecked,
                                    {
                                      date: intl.formatDate(
                                        sourceStatus.lastChecked,
                                        {
                                          dateStyle: 'medium',
                                          timeStyle: 'short',
                                        }
                                      ),
                                    }
                                  )}
                                </>
                              )}
                            </p>
                          );
                        })}
                        {searchIndexStatus.nextRefreshAt && (
                          <p className="mb-2 text-sm text-gray-400">
                            {intl.formatMessage(messages.searchIndexNext, {
                              date: intl.formatDate(
                                searchIndexStatus.nextRefreshAt,
                                { dateStyle: 'medium', timeStyle: 'short' }
                              ),
                            })}
                          </p>
                        )}
                        <Button
                          type="button"
                          buttonSize="sm"
                          disabled={searchIndexStatus.refreshing}
                          onClick={async () => {
                            try {
                              await axios.post(
                                '/api/v1/settings/search-index/refresh'
                              );
                              await refreshSearchIndexStatus();
                            } catch {
                              addToast(
                                intl.formatMessage(
                                  messages.searchIndexRefreshFailed
                                ),
                                { autoDismiss: true, appearance: 'error' }
                              );
                              await refreshSearchIndexStatus();
                            }
                          }}
                        >
                          {intl.formatMessage(messages.searchIndexRefresh)}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}
              <div className="form-row">
                <label htmlFor="smartSearch" className="checkbox-label">
                  {intl.formatMessage(messages.smartSearch)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.smartSearchTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id="smartSearch"
                    name="smartSearch"
                    onChange={() =>
                      setFieldValue('smartSearch', !values.smartSearch)
                    }
                  />
                </div>
              </div>
              {values.smartSearch && (
                <div className="form-row">
                  <label htmlFor="smartSearchDevice" className="text-label">
                    {intl.formatMessage(messages.smartSearchDevice)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.smartSearchDeviceTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      as="select"
                      id="smartSearchDevice"
                      name="smartSearchDevice"
                    >
                      <option value="auto">
                        {intl.formatMessage(messages.smartSearchDeviceAuto)}
                      </option>
                      <option value="cpu">
                        {intl.formatMessage(messages.smartSearchDeviceCpu)}
                      </option>
                      {(smartStatus?.externalAvailable ||
                        values.smartSearchDevice === 'external') && (
                        <option value="external">
                          {intl.formatMessage(messages.smartSearchDeviceHost)}
                        </option>
                      )}
                      {smartStatus?.devices.map((device) => (
                        <option key={device.name} value={device.name}>
                          {device.description} ({device.name})
                        </option>
                      ))}
                      {values.smartSearchDevice !== 'auto' &&
                        values.smartSearchDevice !== 'cpu' &&
                        values.smartSearchDevice !== 'external' &&
                        !smartStatus?.devices.some(
                          (device) => device.name === values.smartSearchDevice
                        ) && (
                          <option value={values.smartSearchDevice}>
                            {values.smartSearchDevice} (unavailable)
                          </option>
                        )}
                    </Field>
                  </div>
                </div>
              )}
              {values.smartSearch && (
                <div className="form-row">
                  <label htmlFor="smartSearchRerank" className="checkbox-label">
                    {intl.formatMessage(messages.rerank)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.rerankTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="smartSearchRerank"
                      name="smartSearchRerank"
                    />
                  </div>
                </div>
              )}
              {values.smartSearch && values.smartSearchRerank && (
                <div className="form-row">
                  <label
                    htmlFor="smartSearchRerankCandidates"
                    className="text-label"
                  >
                    {intl.formatMessage(messages.rerankCandidates)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.rerankCandidatesTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      as="select"
                      id="smartSearchRerankCandidates"
                      name="smartSearchRerankCandidates"
                      onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                        setFieldValue(
                          'smartSearchRerankCandidates',
                          Number(event.target.value)
                        )
                      }
                    >
                      <option value={20}>
                        {intl.formatMessage(messages.rerank20)}
                      </option>
                      <option value={40}>
                        {intl.formatMessage(messages.rerank40)}
                      </option>
                      <option value={80}>
                        {intl.formatMessage(messages.rerank80)}
                      </option>
                      {![20, 40, 80].includes(
                        values.smartSearchRerankCandidates
                      ) && (
                        <option value={values.smartSearchRerankCandidates}>
                          {values.smartSearchRerankCandidates}
                        </option>
                      )}
                    </Field>
                  </div>
                </div>
              )}
              {values.smartSearch && (
                <div className="form-row">
                  <label
                    htmlFor="smartSearchRefreshInterval"
                    className="text-label"
                  >
                    {intl.formatMessage(messages.smartRefreshInterval)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.smartRefreshIntervalTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      as="select"
                      id="smartSearchRefreshInterval"
                      name="smartSearchRefreshInterval"
                    >
                      <option value="daily">
                        {intl.formatMessage(messages.refreshDaily)}
                      </option>
                      <option value="weekly">
                        {intl.formatMessage(messages.refreshWeekly)}
                      </option>
                      <option value="manual">
                        {intl.formatMessage(messages.refreshManual)}
                      </option>
                    </Field>
                  </div>
                </div>
              )}
              {data?.smartSearch && smartStatusError && (
                <p className="mb-3 text-sm text-red-400">
                  {intl.formatMessage(messages.smartStatusError)}
                </p>
              )}
              {data?.smartSearch && smartStatus && (
                <div className="form-row">
                  <div className="form-input-area">
                    <p className="mb-1 text-sm text-gray-300">
                      {intl.formatMessage(messages.smartSearchStatus, {
                        phase: smartStatus.phase,
                        count: smartStatus.count,
                      })}
                    </p>
                    <p className="mb-1 text-sm text-gray-300">
                      {intl.formatMessage(
                        smartStatus.indexing
                          ? messages.indexUpdating
                          : smartStatus.count > 0
                            ? messages.indexAvailable
                            : messages.indexWaiting
                      )}
                    </p>
                    {smartStatus.activeDevice && (
                      <p className="mb-1 text-sm text-gray-300">
                        {intl.formatMessage(messages.smartSearchActiveDevice, {
                          device: smartStatus.activeDevice,
                        })}
                      </p>
                    )}
                    {smartStatus.deviceWarning && (
                      <p className="mb-2 text-sm text-yellow-400">
                        {smartStatus.deviceWarning}
                      </p>
                    )}
                    {smartStatus.phase === 'downloading' &&
                      smartStatus.downloadTotal > 0 && (
                        <p className="mb-1 text-sm text-gray-300">
                          {intl.formatMessage(messages.smartSearchDownload, {
                            percent: Math.min(
                              100,
                              Math.round(
                                (smartStatus.downloadBytes * 100) /
                                  smartStatus.downloadTotal
                              )
                            ),
                          })}
                        </p>
                      )}
                    {progress?.popular && (
                      <p className="mb-1 text-sm text-gray-300">
                        {intl.formatMessage(
                          progress.popular.paused
                            ? progress.popular.totalPages
                              ? messages.popularPausedTotal
                              : messages.popularPaused
                            : progress.popular.totalPages
                              ? messages.popularProgressTotal
                              : messages.popularProgress,
                          {
                            total: progress.popular.totalPages,
                            mediaType: intl.formatMessage(
                              progress.popular.type === 'movie'
                                ? messages.popularMovies
                                : messages.popularSeries
                            ),
                            page: progress.popular.page,
                          }
                        )}
                      </p>
                    )}
                    {progress?.chronological && (
                      <p className="mb-1 text-sm text-gray-300">
                        {intl.formatMessage(
                          progress.chronological.paused
                            ? messages.scanPausedDetailed
                            : messages.scanProgressDetailed,
                          {
                            mediaType: intl.formatMessage(
                              progress.chronological.mediaType === 'movie'
                                ? messages.popularMovies
                                : messages.popularSeries
                            ),
                            period: progress.chronological.period,
                            page: progress.chronological.page,
                          }
                        )}
                      </p>
                    )}
                    {smartStatus.indexing && (
                      <p className="mb-1 text-sm text-gray-400">
                        {intl.formatMessage(messages.indexCoverageTip)}
                      </p>
                    )}
                    {smartStatus.nextRefreshAt && (
                      <p className="mb-1 text-sm text-gray-400">
                        {intl.formatMessage(messages.searchIndexNext, {
                          date: intl.formatDate(smartStatus.nextRefreshAt, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          }),
                        })}
                      </p>
                    )}
                    {smartStatus.lexical && (
                      <p className="mb-1 text-sm text-gray-300">
                        {intl.formatMessage(messages.lexicalProgress, {
                          indexed: intl.formatNumber(
                            smartStatus.lexical.indexed
                          ),
                          total: intl.formatNumber(smartStatus.lexical.total),
                        })}
                      </p>
                    )}
                    {smartStatus.lexical?.indexing && (
                      <p className="mb-1 text-sm text-gray-400">
                        {intl.formatMessage(messages.lexicalUpdating)}
                      </p>
                    )}
                    {smartStatus.lexical?.error && (
                      <p className="mb-1 text-sm text-red-400">
                        {smartStatus.lexical.error}
                      </p>
                    )}
                    {smartStatus.reranker?.enabled && (
                      <div className="mb-2 text-sm text-gray-300">
                        <p>
                          {intl.formatMessage(messages.rerankStatus, {
                            phase: smartStatus.reranker.phase,
                          })}
                        </p>
                        {smartStatus.reranker.phase === 'downloading' &&
                          smartStatus.reranker.downloadTotal > 0 && (
                            <p>
                              {intl.formatMessage(
                                messages.smartSearchDownload,
                                {
                                  percent: Math.min(
                                    100,
                                    Math.round(
                                      (smartStatus.reranker.downloadBytes *
                                        100) /
                                        smartStatus.reranker.downloadTotal
                                    )
                                  ),
                                }
                              )}
                            </p>
                          )}
                        {smartStatus.reranker.activeDevice && (
                          <p>
                            {intl.formatMessage(
                              messages.smartSearchActiveDevice,
                              { device: smartStatus.reranker.activeDevice }
                            )}
                          </p>
                        )}
                        {smartStatus.reranker.error && (
                          <p className="text-red-400">
                            {smartStatus.reranker.error}
                          </p>
                        )}
                      </div>
                    )}
                    {smartStatus.error && (
                      <p className="mb-2 text-sm text-red-400">
                        {smartStatus.error}
                      </p>
                    )}
                    <Button
                      type="button"
                      buttonSize="sm"
                      disabled={smartStatus.indexing}
                      onClick={async () => {
                        try {
                          await axios.post(
                            '/api/v1/settings/smart-search/refresh'
                          );
                          await refreshSmartStatus();
                        } catch {
                          addToast(
                            intl.formatMessage(
                              messages.smartSearchRefreshFailed
                            ),
                            { autoDismiss: true, appearance: 'error' }
                          );
                        }
                      }}
                    >
                      {intl.formatMessage(messages.searchIndexRefresh)}
                    </Button>
                  </div>
                </div>
              )}

              <div className="actions">
                <div className="flex justify-end">
                  <Button
                    buttonType="primary"
                    type="submit"
                    disabled={isSubmitting || !dirty}
                  >
                    <ArrowDownOnSquareIcon />
                    <span>
                      {intl.formatMessage(
                        isSubmitting
                          ? globalMessages.saving
                          : globalMessages.save
                      )}
                    </span>
                  </Button>
                </div>
              </div>
            </Form>
          )}
        </Formik>
      </div>
    </>
  );
};
export default SettingsSearch;
