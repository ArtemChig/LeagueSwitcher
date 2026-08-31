/**
 * P2.7 — external profile links.
 *
 * Constructed from the Riot ID and region, never scraped (PLAN §4.7). Every one of these sites
 * takes `gameName-tagLine` in the path, so the only real work is encoding and the per-site
 * region slug.
 *
 * A Riot ID can contain spaces ("SUMMONER ONE"), which must be percent-encoded or the link
 * silently 404s.
 */
import { REGION_TO_OPGG, platformFromPlatformId, platformFromRegion } from "./routing.js";

export interface ExternalLink {
  id: string;
  label: string;
  url: string;
}

export interface LinkTarget {
  gameName: string | null;
  tagLine: string | null;
  region: string | null;
  /** e.g. "NA1", straight from the Riot Client. Preferred over `region` when available. */
  platformId?: string | null;
}

/**
 * All the links for an account, or `[]` when there is no Riot ID to build them from.
 *
 * The two sites take DIFFERENT region identifiers, and conflating them is a bug that only
 * shows up outside NA:
 *
 *   op.gg / DeepLoL / Porofessor — a region slug: `na`, `euw`, `kr`, `lan`
 *   u.gg                        — a platform host: `na1`, `euw1`, `kr`, `la1`
 *
 * An earlier version built u.gg's path as `${slug}1`, which is right for `na1` and `euw1` and
 * silently wrong for every region where the two differ — `kr1`, `ru1` and `lan1` are not real
 * platforms. The platform host is now looked up properly.
 */
export function buildExternalLinks({ gameName, tagLine, region, platformId }: LinkTarget): ExternalLink[] {
  if (!gameName || !tagLine) return [];

  const slug = REGION_TO_OPGG[(region ?? "NA").toUpperCase()] ?? (region ?? "na").toLowerCase();
  const platformHost = platformFromPlatformId(platformId) ?? platformFromRegion(region) ?? "na1";
  const combined = `${encodeURIComponent(gameName)}-${encodeURIComponent(tagLine)}`;

  return [
    { id: "opgg", label: "op.gg", url: `https://op.gg/lol/summoners/${slug}/${combined}` },
    { id: "ugg", label: "u.gg", url: buildUggUrl(gameName, tagLine, platformHost) },
    { id: "deeplol", label: "DeepLoL", url: `https://www.deeplol.gg/summoner/${slug}/${combined}` },
    { id: "porofessor", label: "Porofessor", url: `https://porofessor.gg/live/${slug}/${combined}` },
  ];
}

/** u.gg wants a platform host (`na1`, `la1`, `kr`), not a region slug. */
export function buildUggUrl(gameName: string, tagLine: string, platformHost: string): string {
  return `https://u.gg/lol/profile/${platformHost}/${encodeURIComponent(gameName)}-${encodeURIComponent(tagLine)}/overview`;
}

/** Data Dragon profile icon. Version is pinned by the asset cache (P2.5). */
export function profileIconUrl(iconId: number, version: string): string {
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/profileicon/${iconId}.png`;
}

/** Community Dragon rank mini-crest. */
export function rankCrestUrl(tier: string): string {
  const t = (tier || "unranked").toLowerCase();
  return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-mini-crests/${t}.svg`;
}
