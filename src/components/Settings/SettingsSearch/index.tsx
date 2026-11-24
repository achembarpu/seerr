import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  AdjustmentsHorizontalIcon,
  ArrowDownOnSquareIcon,
  ArrowPathIcon,
  MagnifyingGlassIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
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
  rescanCatalog: 'Rescan catalog',

  titleCardTitle: 'Title search',
  titleCardDescription:
    'Find movies and series by title, including misspellings. Uses locally indexed IMDb and TMDB titles.',
  smartCardTitle: 'Smart search',
  smartCardDescription:
    'Find movies and series by their descriptions, and discover similar titles. Uses a locally downloaded embedding model.',
  rerankCardTitle: 'Relevance reranking',
  rerankRequiresSmart: 'Turn on smart search to use reranking.',
  titleSources: 'Title index sources',
  descriptionIndex: 'Description index',
  indexedTitles: 'Indexed titles',
  keywordIndex: 'Keyword index',
  enabled: 'Enabled',
  saveToStart: 'Save your changes to apply these settings.',
  embeddingModelStatus: 'Embedding model: {phase}',
  unsavedChanges: 'You have unsaved changes.',
  embeddingDownload: 'Embedding model download',
  rerankerDownload: 'Reranker model download',
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
  lexicalProgress: '{indexed} of {total} descriptions',
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
  rerankCandidates: 'Maximum candidates to rerank',
  rerankCandidatesTip:
    'More candidates can improve coverage but take more time and inference resources.',
  rerank20: '20 — faster',
  rerank40: '40 — balanced',
  rerank80: '80 — more thorough',
  titleRefreshInterval: 'Title index refresh schedule',
  titleRefreshIntervalTip:
    'Daily and weekly check for title updates automatically. Manual only uses the current index until Refresh now is pressed.',
  smartRefreshInterval: 'Description index refresh schedule',
  liveKeywords: 'Allow TMDB keyword fallback',
  liveKeywordsTip:
    'Search the local indexes first. If the local evidence is weak, TMDB can help find additional plot matches. Turn this off to keep plot searches local.',
  smartRefreshIntervalTip:
    'Daily and weekly run the initial scan and check for updates automatically. Manual only requires Refresh now to start or resume indexing and to check for updates.',
  refreshDaily: 'Daily',
  refreshWeekly: 'Weekly',
  refreshManual: 'Manual only',
});

const ModelProgress = ({
  label,
  bytes,
  total,
}: {
  label: string;
  bytes: number;
  total: number;
}) => {
  const percent = Math.min(100, Math.max(0, Math.round((bytes * 100) / total)));
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between gap-3 text-xs text-gray-400">
        <span>{label}</span>
        <span>{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-gray-700"
      >
        <div
          className="h-full rounded-full bg-indigo-400"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
};

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
  const refreshSmartSearch = async (mode?: 'rescan') => {
    try {
      await axios.post('/api/v1/settings/smart-search/refresh', undefined, {
        params: { mode },
      });
      await refreshSmartStatus();
    } catch {
      addToast(intl.formatMessage(messages.smartSearchRefreshFailed), {
        autoDismiss: true,
        appearance: 'error',
      });
    }
  };

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
            smartSearchLiveKeywords: data.smartSearchLiveKeywords ?? true,
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
            <Form className="space-y-6" data-testid="settings-search-form">
              <section className="overflow-hidden rounded-lg bg-gray-800 shadow ring-1 ring-gray-700">
                <div className="flex items-start justify-between gap-4 p-5 sm:p-6">
                  <div className="flex min-w-0 items-start gap-4">
                    <div className="rounded-lg bg-indigo-500/10 p-2.5 text-indigo-400 ring-1 ring-inset ring-indigo-500/20">
                      <MagnifyingGlassIcon className="h-5 w-5" />
                    </div>
                    <div>
                      <h4 className="text-lg font-semibold text-gray-100">
                        {intl.formatMessage(messages.titleCardTitle)}
                      </h4>
                      <p className="mt-1 max-w-2xl text-sm leading-5 text-gray-400">
                        {intl.formatMessage(messages.titleCardDescription)}
                      </p>
                      <a
                        href="https://help.imdb.com/article/imdb/general-information/can-i-use-imdb-data-in-my-software/G5JTRESSHJBBHTGX"
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-block text-sm text-indigo-300 hover:text-indigo-200 hover:underline"
                      >
                        {intl.formatMessage(messages.localTitleSearchTerms)}
                      </a>
                    </div>
                  </div>
                  <label
                    htmlFor="localTitleSearch"
                    className="flex shrink-0 items-center gap-2 text-sm text-gray-300"
                  >
                    <span>{intl.formatMessage(messages.enabled)}</span>
                    <Field
                      type="checkbox"
                      id="localTitleSearch"
                      name="localTitleSearch"
                    />
                  </label>
                </div>
                {values.localTitleSearch && (
                  <div className="space-y-5 border-t border-gray-700 p-5 sm:p-6">
                    <div className="grid gap-2 sm:grid-cols-3 sm:items-start sm:gap-4">
                      <label
                        htmlFor="localTitleSearchRefreshInterval"
                        className="text-label"
                      >
                        {intl.formatMessage(messages.titleRefreshInterval)}
                        <span className="label-tip">
                          {intl.formatMessage(messages.titleRefreshIntervalTip)}
                        </span>
                      </label>
                      <div className="sm:col-span-2">
                        <Field
                          as="select"
                          id="localTitleSearchRefreshInterval"
                          name="localTitleSearchRefreshInterval"
                          className="w-full sm:max-w-xs"
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
                    {!data.localTitleSearch && (
                      <p className="text-sm text-gray-400">
                        {intl.formatMessage(messages.saveToStart)}
                      </p>
                    )}
                    {data.localTitleSearch && (
                      <div className="rounded-md bg-gray-900/50 p-4 ring-1 ring-gray-700">
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                          <h5 className="text-sm font-semibold text-gray-200">
                            {intl.formatMessage(messages.titleSources)}
                          </h5>
                          {searchIndexStatus && (
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
                              <ArrowPathIcon />
                              <span>
                                {intl.formatMessage(
                                  messages.searchIndexRefresh
                                )}
                              </span>
                            </Button>
                          )}
                        </div>
                        {searchIndexError && (
                          <p className="text-sm text-red-400">
                            {intl.formatMessage(
                              messages.searchIndexStatusFailed
                            )}
                          </p>
                        )}
                        {searchIndexStatus && (
                          <>
                            <div className="grid gap-2 sm:grid-cols-2">
                              {Object.entries(sourceLabels).map(
                                ([source, label]) => {
                                  const key =
                                    source as keyof typeof sourceLabels;
                                  const sourceStatus =
                                    searchIndexStatus.sources[key];
                                  const updating =
                                    searchIndexStatus.currentSource === key;
                                  const failed =
                                    searchIndexStatus.failedSources.includes(
                                      key
                                    );
                                  const sourceLabel = updating
                                    ? messages.searchIndexUpdating
                                    : failed
                                      ? data.localTitleSearchRefreshInterval ===
                                        'manual'
                                        ? messages.searchIndexFailedManual
                                        : messages.searchIndexFailed
                                      : sourceStatus.available
                                        ? messages.searchIndexReady
                                        : messages.searchIndexWaiting;
                                  return (
                                    <div
                                      key={key}
                                      className="rounded-md bg-gray-800/70 px-3 py-2.5"
                                    >
                                      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
                                        <span className="font-medium text-gray-200">
                                          {intl.formatMessage(label)}
                                        </span>
                                        <span
                                          className={`inline-flex items-center gap-1.5 text-xs ${failed ? 'text-red-400' : updating ? 'text-indigo-300' : sourceStatus.available ? 'text-green-400' : 'text-gray-400'}`}
                                        >
                                          <span
                                            aria-hidden="true"
                                            className={`h-1.5 w-1.5 rounded-full ${failed ? 'bg-red-400' : updating ? 'bg-indigo-400' : sourceStatus.available ? 'bg-green-400' : 'bg-gray-500'}`}
                                          />
                                          {intl.formatMessage(sourceLabel)}
                                        </span>
                                      </div>
                                      {sourceStatus.lastChecked && (
                                        <p className="mt-1 text-xs text-gray-400">
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
                                        </p>
                                      )}
                                    </div>
                                  );
                                }
                              )}
                            </div>
                            {searchIndexStatus.nextRefreshAt && (
                              <p className="mt-3 text-xs text-gray-400">
                                {intl.formatMessage(messages.searchIndexNext, {
                                  date: intl.formatDate(
                                    searchIndexStatus.nextRefreshAt,
                                    { dateStyle: 'medium', timeStyle: 'short' }
                                  ),
                                })}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section className="overflow-hidden rounded-lg bg-gray-800 shadow ring-1 ring-gray-700">
                <div className="flex items-start justify-between gap-4 p-5 sm:p-6">
                  <div className="flex min-w-0 items-start gap-4">
                    <div className="rounded-lg bg-indigo-500/10 p-2.5 text-indigo-400 ring-1 ring-inset ring-indigo-500/20">
                      <SparklesIcon className="h-5 w-5" />
                    </div>
                    <div>
                      <h4 className="text-lg font-semibold text-gray-100">
                        {intl.formatMessage(messages.smartCardTitle)}
                      </h4>
                      <p className="mt-1 max-w-2xl text-sm leading-5 text-gray-400">
                        {intl.formatMessage(messages.smartCardDescription)}
                      </p>
                    </div>
                  </div>
                  <label
                    htmlFor="smartSearch"
                    className="flex shrink-0 items-center gap-2 text-sm text-gray-300"
                  >
                    <span>{intl.formatMessage(messages.enabled)}</span>
                    <Field
                      type="checkbox"
                      id="smartSearch"
                      name="smartSearch"
                    />
                  </label>
                </div>
                {values.smartSearch && (
                  <div className="space-y-5 border-t border-gray-700 p-5 sm:p-6">
                    <div>
                      <label
                        htmlFor="smartSearchLiveKeywords"
                        className="flex items-center gap-2 text-sm text-gray-300"
                      >
                        <Field
                          type="checkbox"
                          id="smartSearchLiveKeywords"
                          name="smartSearchLiveKeywords"
                          aria-describedby="smart-search-live-keywords-tip"
                        />
                        {intl.formatMessage(messages.liveKeywords)}
                      </label>
                      <p
                        id="smart-search-live-keywords-tip"
                        className="mt-1.5 text-xs leading-5 text-gray-400"
                      >
                        {intl.formatMessage(messages.liveKeywordsTip)}
                      </p>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label htmlFor="smartSearchDevice">
                          {intl.formatMessage(messages.smartSearchDevice)}
                        </label>
                        <Field
                          as="select"
                          id="smartSearchDevice"
                          name="smartSearchDevice"
                          className="w-full"
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
                              {intl.formatMessage(
                                messages.smartSearchDeviceHost
                              )}
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
                              (device) =>
                                device.name === values.smartSearchDevice
                            ) && (
                              <option value={values.smartSearchDevice}>
                                {values.smartSearchDevice} (unavailable)
                              </option>
                            )}
                        </Field>
                        <p className="mt-1.5 text-xs leading-5 text-gray-400">
                          {intl.formatMessage(messages.smartSearchDeviceTip)}
                        </p>
                      </div>
                      <div>
                        <label htmlFor="smartSearchRefreshInterval">
                          {intl.formatMessage(messages.smartRefreshInterval)}
                        </label>
                        <Field
                          as="select"
                          id="smartSearchRefreshInterval"
                          name="smartSearchRefreshInterval"
                          className="w-full"
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
                        <p className="mt-1.5 text-xs leading-5 text-gray-400">
                          {intl.formatMessage(messages.smartRefreshIntervalTip)}
                        </p>
                      </div>
                    </div>
                    {!data.smartSearch && (
                      <p className="text-sm text-gray-400">
                        {intl.formatMessage(messages.saveToStart)}
                      </p>
                    )}
                    {data.smartSearch && smartStatusError && (
                      <p className="text-sm text-red-400">
                        {intl.formatMessage(messages.smartStatusError)}
                      </p>
                    )}
                    {data.smartSearch && smartStatus && (
                      <div className="rounded-md bg-gray-900/50 p-4 ring-1 ring-gray-700">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h5 className="text-sm font-semibold text-gray-200">
                              {intl.formatMessage(messages.descriptionIndex)}
                            </h5>
                            <p className="mt-1 text-sm text-gray-400">
                              {intl.formatMessage(
                                smartStatus.indexing
                                  ? messages.indexUpdating
                                  : smartStatus.count > 0
                                    ? messages.indexAvailable
                                    : messages.indexWaiting
                              )}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {smartStatus.count > 0 && !smartStatus.cursor && (
                              <Button
                                type="button"
                                buttonType="ghost"
                                buttonSize="sm"
                                disabled={smartStatus.indexing}
                                onClick={() => refreshSmartSearch('rescan')}
                              >
                                {intl.formatMessage(messages.rescanCatalog)}
                              </Button>
                            )}
                            <Button
                              type="button"
                              buttonSize="sm"
                              disabled={smartStatus.indexing}
                              onClick={() => refreshSmartSearch()}
                            >
                              <ArrowPathIcon />
                              <span>
                                {intl.formatMessage(
                                  messages.searchIndexRefresh
                                )}
                              </span>
                            </Button>
                          </div>
                        </div>
                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          <div className="rounded-md bg-gray-800/70 px-3 py-2.5">
                            <p className="text-xs font-medium text-gray-400">
                              {intl.formatMessage(messages.indexedTitles)}
                            </p>
                            <p className="mt-0.5 text-lg font-semibold text-gray-100">
                              {intl.formatNumber(smartStatus.count)}
                            </p>
                          </div>
                          {smartStatus.lexical && (
                            <div className="rounded-md bg-gray-800/70 px-3 py-2.5">
                              <p className="text-xs font-medium text-gray-400">
                                {intl.formatMessage(messages.keywordIndex)}
                              </p>
                              <p className="mt-0.5 text-sm font-medium text-gray-200">
                                {intl.formatMessage(messages.lexicalProgress, {
                                  indexed: intl.formatNumber(
                                    smartStatus.lexical.indexed
                                  ),
                                  total: intl.formatNumber(
                                    smartStatus.lexical.total
                                  ),
                                })}
                              </p>
                              {smartStatus.lexical.indexing && (
                                <p className="mt-1 text-xs text-gray-400">
                                  {intl.formatMessage(messages.lexicalUpdating)}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="mt-3 space-y-1 text-sm text-gray-400">
                          <p>
                            {intl.formatMessage(messages.embeddingModelStatus, {
                              phase: smartStatus.phase,
                            })}
                          </p>
                          {smartStatus.activeDevice && (
                            <p>
                              {intl.formatMessage(
                                messages.smartSearchActiveDevice,
                                { device: smartStatus.activeDevice }
                              )}
                            </p>
                          )}
                          {progress?.popular && (
                            <p>
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
                            <p>
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
                            <p>
                              {intl.formatMessage(messages.indexCoverageTip)}
                            </p>
                          )}
                          {smartStatus.nextRefreshAt && (
                            <p>
                              {intl.formatMessage(messages.searchIndexNext, {
                                date: intl.formatDate(
                                  smartStatus.nextRefreshAt,
                                  { dateStyle: 'medium', timeStyle: 'short' }
                                ),
                              })}
                            </p>
                          )}
                          {smartStatus.deviceWarning && (
                            <p className="text-yellow-400">
                              {smartStatus.deviceWarning}
                            </p>
                          )}
                          {smartStatus.retrievalWarning && (
                            <p className="text-yellow-400">
                              {smartStatus.retrievalWarning}
                            </p>
                          )}
                          {smartStatus.lexical?.error && (
                            <p className="text-red-400">
                              {smartStatus.lexical.error}
                            </p>
                          )}
                          {smartStatus.error && (
                            <p className="text-red-400">{smartStatus.error}</p>
                          )}
                        </div>
                        {smartStatus.phase === 'downloading' &&
                          smartStatus.downloadTotal > 0 && (
                            <ModelProgress
                              label={intl.formatMessage(
                                messages.embeddingDownload
                              )}
                              bytes={smartStatus.downloadBytes}
                              total={smartStatus.downloadTotal}
                            />
                          )}
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section className="overflow-hidden rounded-lg bg-gray-800 shadow ring-1 ring-gray-700">
                <div className="flex items-start justify-between gap-4 p-5 sm:p-6">
                  <div className="flex min-w-0 items-start gap-4">
                    <div className="rounded-lg bg-indigo-500/10 p-2.5 text-indigo-400 ring-1 ring-inset ring-indigo-500/20">
                      <AdjustmentsHorizontalIcon className="h-5 w-5" />
                    </div>
                    <div>
                      <h4 className="text-lg font-semibold text-gray-100">
                        {intl.formatMessage(messages.rerankCardTitle)}
                      </h4>
                      <p className="mt-1 max-w-2xl text-sm leading-5 text-gray-400">
                        {intl.formatMessage(messages.rerankTip)}
                      </p>
                      {!values.smartSearch && (
                        <p className="mt-2 text-sm text-gray-400">
                          {intl.formatMessage(messages.rerankRequiresSmart)}
                        </p>
                      )}
                    </div>
                  </div>
                  <label
                    htmlFor="smartSearchRerank"
                    className="flex shrink-0 items-center gap-2 text-sm text-gray-300"
                  >
                    <span>{intl.formatMessage(messages.enabled)}</span>
                    <Field
                      type="checkbox"
                      id="smartSearchRerank"
                      name="smartSearchRerank"
                      disabled={!values.smartSearch}
                    />
                  </label>
                </div>
                {values.smartSearch && values.smartSearchRerank && (
                  <div className="space-y-5 border-t border-gray-700 p-5 sm:p-6">
                    <div className="grid gap-2 sm:grid-cols-3 sm:items-start sm:gap-4">
                      <label
                        htmlFor="smartSearchRerankCandidates"
                        className="text-label"
                      >
                        {intl.formatMessage(messages.rerankCandidates)}
                        <span className="label-tip">
                          {intl.formatMessage(messages.rerankCandidatesTip)}
                        </span>
                      </label>
                      <div className="sm:col-span-2">
                        <Field
                          as="select"
                          id="smartSearchRerankCandidates"
                          name="smartSearchRerankCandidates"
                          className="w-full sm:max-w-xs"
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
                    {smartStatus?.reranker?.enabled && (
                      <div className="rounded-md bg-gray-900/50 p-4 text-sm text-gray-300 ring-1 ring-gray-700">
                        <p className="font-medium text-gray-200">
                          {intl.formatMessage(messages.rerankStatus, {
                            phase: smartStatus.reranker.phase,
                          })}
                        </p>
                        {smartStatus.reranker.activeDevice && (
                          <p className="mt-1 text-gray-400">
                            {intl.formatMessage(
                              messages.smartSearchActiveDevice,
                              { device: smartStatus.reranker.activeDevice }
                            )}
                          </p>
                        )}
                        {smartStatus.reranker.error && (
                          <p className="mt-1 text-red-400">
                            {smartStatus.reranker.error}
                          </p>
                        )}
                        {smartStatus.reranker.phase === 'downloading' &&
                          smartStatus.reranker.downloadTotal > 0 && (
                            <ModelProgress
                              label={intl.formatMessage(
                                messages.rerankerDownload
                              )}
                              bytes={smartStatus.reranker.downloadBytes}
                              total={smartStatus.reranker.downloadTotal}
                            />
                          )}
                      </div>
                    )}
                  </div>
                )}
              </section>

              <div className="actions flex flex-wrap items-center justify-between gap-3">
                {dirty ? (
                  <p className="text-sm text-gray-400">
                    {intl.formatMessage(messages.unsavedChanges)}
                  </p>
                ) : (
                  <span />
                )}
                <Button
                  buttonType="primary"
                  type="submit"
                  disabled={isSubmitting || !dirty}
                >
                  <ArrowDownOnSquareIcon />
                  <span>
                    {intl.formatMessage(
                      isSubmitting ? globalMessages.saving : globalMessages.save
                    )}
                  </span>
                </Button>
              </div>
            </Form>
          )}
        </Formik>
      </div>
    </>
  );
};
export default SettingsSearch;
