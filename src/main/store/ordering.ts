/**
 * Card ordering.
 *
 * Extracted from index.ts so it can be tested directly: ordering is easy to get subtly wrong
 * and invisible in review — an unknown tier that sorts to -1 lands FIRST in an ascending sort,
 * which puts unranked accounts above Challenger.
 */

/** Highest first. Anything absent from this list is "no rank", which sorts last. */
export const TIER_ORDER = [
  "CHALLENGER",
  "GRANDMASTER",
  "MASTER",
  "DIAMOND",
  "EMERALD",
  "PLATINUM",
  "GOLD",
  "SILVER",
  "BRONZE",
  "IRON",
] as const;

/** Below every real tier, so unranked and unknown-tier accounts sort to the bottom. */
const NO_RANK = Number.MAX_SAFE_INTEGER;

export function tierRank(rankLabel: string | null | undefined): number {
  const tier = (rankLabel ?? "").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  const index = TIER_ORDER.indexOf(tier as (typeof TIER_ORDER)[number]);
  return index < 0 ? NO_RANK : index;
}

export interface Orderable {
  isActive: boolean;
  rankLabel: string;
  riotIdLabel: string;
}

/**
 * Active account first (PLAN §5 pins it), then by tier, then by name.
 *
 * The active account is pinned regardless of its rank — that is deliberate, so "where am I
 * signed in" is answerable without reading. It does mean an unranked active account sits above
 * ranked ones, which is the pin doing its job rather than the tier ordering failing.
 */
export function compareForRankSort(a: Orderable, b: Orderable): number {
  if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
  return tierRank(a.rankLabel) - tierRank(b.rankLabel) || a.riotIdLabel.localeCompare(b.riotIdLabel);
}
