import type { PersonCredit } from '@server/models/Person';

export type CreditMediaType = 'all' | 'movie' | 'tv';
export type CreditSort = 'top' | 'newest';

const audiencePrior = 150;
const priorRating = 5;

const positiveNumber = (value: number) =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

const creditScore = (rating: number, votes: number, episodes: number) => {
  const average = positiveNumber(rating);
  const support = average > 0 && average <= 10 ? votes : 0;

  // Shrink poorly supported ratings toward a conservative midpoint.
  const weightedRating =
    (average * support + priorRating * audiencePrior) /
    (support + audiencePrior);
  const reach = Math.min(1, Math.log1p(votes) / Math.log1p(10000));
  const role =
    episodes === 1
      ? -0.25
      : episodes > 1
        ? Math.min(0.2, Math.log2(episodes) * 0.05)
        : 0;
  return weightedRating + reach * 0.75 + role;
};

export function rankCredits<T extends PersonCredit>(
  credits: readonly T[],
  filter: CreditMediaType,
  sort: CreditSort,
  getRole: (credit: T) => string,
  knownForDepartment?: string
) {
  const titles = new Map<
    string,
    {
      credit: T & { mediaType: 'movie' | 'tv' };
      roles: Set<string>;
      episodes: number;
      mainDepartment: boolean;
    }
  >();

  for (const credit of credits) {
    const { mediaType } = credit;
    if (mediaType !== 'movie' && mediaType !== 'tv') continue;
    if (filter !== 'all' && mediaType !== filter) continue;

    const key = `${mediaType}:${credit.id}`;
    const group = titles.get(key) ?? {
      credit: { ...credit, mediaType },
      roles: new Set<string>(),
      episodes: 0,
      mainDepartment: false,
    };
    const role = getRole(credit)?.trim();
    if (role) group.roles.add(role);
    if (mediaType === 'tv')
      group.episodes = Math.max(
        group.episodes,
        positiveNumber(credit.episodeCount)
      );
    if (
      'department' in credit &&
      knownForDepartment &&
      credit.department === knownForDepartment
    )
      group.mainDepartment = true;
    titles.set(key, group);
  }

  const ranked = [...titles.values()].map(
    ({ credit, roles, episodes, mainDepartment }) => {
      const votes = positiveNumber(credit.voteCount);
      return {
        credit,
        roles: [...roles].join(', '),
        date:
          (credit.mediaType === 'movie'
            ? credit.releaseDate
            : credit.firstAirDate) || '',
        votes,
        score:
          creditScore(credit.voteAverage, votes, episodes) +
          (mainDepartment ? 0.25 : 0),
      };
    }
  );

  return ranked
    .sort((a, b) => {
      const newest = b.date.localeCompare(a.date);
      return (
        (sort === 'newest' ? newest : 0) ||
        b.score - a.score ||
        b.votes - a.votes ||
        newest ||
        a.credit.mediaType.localeCompare(b.credit.mediaType) ||
        a.credit.id - b.credit.id
      );
    })
    .map(({ credit, roles }) => ({ ...credit, roles }));
}
