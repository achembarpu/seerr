import { genres } from '@app/i18n/mediaGenres';
import defineMessages from '@app/utils/defineMessages';
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import type { MatchExplanation } from '@server/models/Search';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.TitleCard.MatchReason', {
  button: 'Why this match?',
  label: 'Why did {title} match?',
  requested: 'Similar to {title}, which you requested.',
  library: 'Similar to {title} in your library.',
  similar: 'Similar to {title}.',
  description: 'Found through plot description similarity.',
  lexical: 'Matched words in the indexed title or synopsis.',
  keywords: 'Found through TMDB keywords.',
  related: 'Suggested by TMDB for a related title.',
  mentions: 'The overview mentions {terms}.',
  genres: 'Genres in common: {genres}.',
});

const genreNames = new Map<number, string>(genres);

const MatchReason = ({
  explanation,
  title,
}: {
  explanation: MatchExplanation;
  title: string;
}) => {
  const intl = useIntl();
  const commonGenres = (explanation.sharedGenreIds ?? [])
    .flatMap((id) => genreNames.get(id) ?? [])
    .slice(0, 3);
  const seedMessage =
    explanation.basis === 'requests'
      ? messages.requested
      : explanation.basis === 'library'
        ? messages.library
        : messages.similar;
  const reasons = [
    explanation.seedTitle &&
      intl.formatMessage(seedMessage, { title: explanation.seedTitle }),
    explanation.terms?.length &&
      intl.formatMessage(messages.mentions, {
        terms: intl.formatList(explanation.terms.map((term) => `“${term}”`)),
      }),
    commonGenres.length &&
      intl.formatMessage(messages.genres, {
        genres: intl.formatList(commonGenres),
      }),
    explanation.description && intl.formatMessage(messages.description),
    explanation.lexical &&
      !explanation.terms?.length &&
      intl.formatMessage(messages.lexical),
    explanation.tmdb &&
      intl.formatMessage(
        explanation.tmdb === 'related' ? messages.related : messages.keywords
      ),
  ].filter(Boolean);
  if (!reasons.length) return null;

  return (
    <Popover className="mt-2">
      <PopoverButton
        className="rounded text-xs font-medium text-gray-400 underline-offset-4 hover:text-gray-100 hover:underline focus-visible:outline focus-visible:outline-indigo-400"
        aria-label={intl.formatMessage(messages.label, { title })}
      >
        {intl.formatMessage(messages.button)}
      </PopoverButton>
      <PopoverPanel
        anchor="bottom start"
        className="z-50 max-w-72 space-y-2 whitespace-normal rounded-lg border border-gray-600 bg-gray-900 p-3 text-sm text-gray-200 shadow-lg [--anchor-gap:6px] [--anchor-padding:12px]"
      >
        {reasons.map((reason, index) => (
          <p key={index}>{reason}</p>
        ))}
      </PopoverPanel>
    </Popover>
  );
};

export default MatchReason;
