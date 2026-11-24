import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import { genres } from '@app/i18n/mediaGenres';
import defineMessages from '@app/utils/defineMessages';
import { InformationCircleIcon } from '@heroicons/react/24/outline';
import type { MatchExplanation } from '@server/models/Search';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.TitleCard.MatchReason', {
  label: 'Why did {title} match?',
  requested: 'Like {title}, a title you requested',
  library: 'Like {title} in your library',
  similar: 'Like {title}',
  description: 'Similar plot',
  lexical: 'Matching words in title or synopsis',
  keywords: 'Matching TMDB keywords',
  related: 'Suggested by TMDB',
  mentions: 'Synopsis mentions {terms}',
  genres: 'Shared genres: {genres}',
});

const genreNames = new Map<number, string>(genres);

const MatchReason = ({
  explanation,
  title,
  isTouch,
}: {
  explanation: MatchExplanation;
  title: string;
  isTouch: boolean;
}) => {
  const intl = useIntl();
  const commonGenres = (explanation.sharedGenreIds ?? [])
    .flatMap((id) => genreNames.get(id) ?? [])
    .slice(0, 2);
  const primary = explanation.seedTitle
    ? intl.formatMessage(
        explanation.basis === 'requests'
          ? messages.requested
          : explanation.basis === 'library'
            ? messages.library
            : messages.similar,
        { title: explanation.seedTitle }
      )
    : explanation.terms?.length
      ? intl.formatMessage(messages.mentions, {
          terms: intl.formatList(
            explanation.terms.slice(0, 2).map((term) => `“${term}”`)
          ),
        })
      : explanation.description
        ? intl.formatMessage(messages.description)
        : explanation.lexical
          ? intl.formatMessage(messages.lexical)
          : explanation.tmdb
            ? intl.formatMessage(
                explanation.tmdb === 'related'
                  ? messages.related
                  : messages.keywords
              )
            : undefined;
  if (!primary) return null;

  return (
    <Tooltip
      tooltipConfig={{
        followCursor: false,
        placement: 'bottom-end',
        offset: [0, 8],
        trigger: isTouch ? 'click' : ['hover', 'focus'],
      }}
      content={
        <div className="max-w-56 whitespace-normal leading-snug">
          <p className="font-medium">{primary}</p>
          {!!commonGenres.length && (
            <p className="mt-1 text-xs text-gray-400">
              {intl.formatMessage(messages.genres, {
                genres: intl.formatList(commonGenres),
              })}
            </p>
          )}
        </div>
      }
    >
      <Button
        type="button"
        buttonSize="sm"
        aria-label={intl.formatMessage(messages.label, { title })}
        className="relative z-40 size-7 rounded-full p-0"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ')
            event.stopPropagation();
        }}
      >
        <InformationCircleIcon className="size-4" aria-hidden="true" />
      </Button>
    </Tooltip>
  );
};

export default MatchReason;
