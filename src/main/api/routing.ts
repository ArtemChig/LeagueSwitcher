/**
 * P2.1 — Riot's two routing tables. They are different, and both are required (PLAN §4.4).
 *
 *   platform routes (na1, euw1, …)      summoner-v4, league-v4
 *   regional routes (americas, europe…) account-v1, match-v5
 *
 * Getting this wrong does not fail loudly — it returns a 404 that looks like "no such player",
 * which is exactly the wrong thing to show on a card.
 */

/** Short region code (what a card shows) -> platform host. */
export const REGION_TO_PLATFORM: Record<string, string> = {
  NA: "na1", BR: "br1", LAN: "la1", LAS: "la2", OCE: "oc1",
  EUW: "euw1", EUNE: "eun1", TR: "tr1", RU: "ru",
  KR: "kr", JP: "jp1",
  PH: "ph2", SG: "sg2", TH: "th2", TW: "tw2", VN: "vn2",
};

/** Platform id as the Riot Client reports it (`userInfo.region.id`) -> platform host. */
export const PLATFORM_ID_TO_HOST: Record<string, string> = {
  NA1: "na1", BR1: "br1", LA1: "la1", LA2: "la2", OC1: "oc1",
  EUW1: "euw1", EUN1: "eun1", TR1: "tr1", RU: "ru",
  KR: "kr", JP1: "jp1",
  PH2: "ph2", SG2: "sg2", TH2: "th2", TW2: "tw2", VN2: "vn2",
};

export type RegionalRoute = "americas" | "europe" | "asia" | "sea";

/**
 * Platform host -> regional route.
 *
 * ⚠️ The SEA cluster is the one to watch. PLAN §4.4 records that OCE has historically routed
 * to `americas` for account-v1 while using `sea` for match-v5, and that it has moved before.
 * This table uses `sea`, matching the routing the API probe verified. Rather than gamble on it
 * staying put, `riotApi.ts` retries an account-v1 404 against the fallback route below — a
 * mis-route and a genuinely missing player are indistinguishable from the status code alone,
 * so the retry costs one request and removes the whole class of bug.
 */
export const PLATFORM_TO_REGIONAL: Record<string, RegionalRoute> = {
  na1: "americas", br1: "americas", la1: "americas", la2: "americas",
  euw1: "europe", eun1: "europe", tr1: "europe", ru: "europe",
  kr: "asia", jp1: "asia",
  oc1: "sea", ph2: "sea", sg2: "sea", th2: "sea", tw2: "sea", vn2: "sea",
};

/** Where to look again when an account-v1 lookup 404s on the primary route. */
export const REGIONAL_FALLBACK: Partial<Record<RegionalRoute, RegionalRoute>> = {
  sea: "americas",
};

export function platformFromRegion(region: string | null | undefined): string | null {
  if (!region) return null;
  return REGION_TO_PLATFORM[region.toUpperCase()] ?? null;
}

export function platformFromPlatformId(platformId: string | null | undefined): string | null {
  if (!platformId) return null;
  const upper = platformId.toUpperCase();
  return PLATFORM_ID_TO_HOST[upper] ?? (upper.toLowerCase() in PLATFORM_TO_REGIONAL ? upper.toLowerCase() : null);
}

export function regionalFromPlatform(platformHost: string | null | undefined): RegionalRoute | null {
  if (!platformHost) return null;
  return PLATFORM_TO_REGIONAL[platformHost.toLowerCase()] ?? null;
}

/** op.gg and friends use their own region slugs, which mostly match the short codes. */
export const REGION_TO_OPGG: Record<string, string> = {
  NA: "na", BR: "br", LAN: "lan", LAS: "las", OCE: "oce",
  EUW: "euw", EUNE: "eune", TR: "tr", RU: "ru",
  KR: "kr", JP: "jp",
  PH: "ph", SG: "sg", TH: "th", TW: "tw", VN: "vn",
};
