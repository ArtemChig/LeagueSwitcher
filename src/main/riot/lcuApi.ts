/**
 * P1.2 — League Client (LCU) API.
 *
 * Phase 0 demoted this module. RESEARCH §4 originally had enrolment reading the Riot ID from
 * `/lol-summoner/v1/current-summoner`, which requires League to be running — but the Riot
 * Client turned out to report `riotID`, `preferred_username`, region, level and profile icon by
 * itself (see rcApi.readLoginState). So the LCU is now purely opportunistic: it supplies the
 * extras the public API does not expose (BE/RP, loot, honour, bans), harvested only if League
 * happens to be open.
 *
 * Consequently EVERY call here is optional. A missing endpoint costs one field, never the
 * harvest — LCU paths churn between patches and are not worth failing over.
 */
import type { Lockfile } from "./lockfile.js";
import { callLocalApi } from "./localApi.js";

export interface CurrentSummoner {
  gameName: string;
  tagLine: string;
  summonerLevel: number;
  profileIconId: number;
  puuid: string;
  xpSinceLastLevel: number;
  xpUntilNextLevel: number;
  percentCompleteForNextLevel: number;
}

export interface RankedEntry {
  tier: string;
  division: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  previousSeasonEndTier: string;
}

/** Everything the LCU can add. Every field is optional by design. */
export interface LcuHarvest {
  harvestedAt: string;
  gameName?: string;
  tagLine?: string;
  summonerLevel?: number;
  profileIconId?: number;
  /** ⚠️ LOCAL puuid — key-scoped, never valid against the public API (RESEARCH §9). */
  localPuuid?: string;
  xpPercentToNextLevel?: number;
  soloDuo?: RankedEntry;
  flex?: RankedEntry;
  blueEssence?: number;
  riotPoints?: number;
  honorLevel?: number;
  ownedChampions?: number;
  lootCount?: number;
  restrictions?: string[];
  /** Endpoints that failed, so the UI can say what is missing rather than showing blanks. */
  unavailable: string[];
}

/** Call an endpoint, returning null on any failure. The whole module's error policy. */
async function optional<T>(lock: Lockfile, path: string, unavailable: string[]): Promise<T | null> {
  try {
    const res = await callLocalApi<T>(lock, "GET", path, { timeoutMs: 8000 });
    if (!res.ok || res.json === null) {
      unavailable.push(path);
      return null;
    }
    return res.json;
  } catch {
    unavailable.push(path);
    return null;
  }
}

export async function getCurrentSummoner(lock: Lockfile): Promise<CurrentSummoner | null> {
  const missing: string[] = [];
  return optional<CurrentSummoner>(lock, "/lol-summoner/v1/current-summoner", missing);
}

/**
 * P2.6 — harvest everything the LCU offers, in parallel, tolerating any subset failing.
 */
export async function harvestFromLcu(lock: Lockfile): Promise<LcuHarvest> {
  const unavailable: string[] = [];
  const harvest: LcuHarvest = { harvestedAt: new Date().toISOString(), unavailable };

  const [summoner, ranked, blueEssence, riotPoints, honor, champions, loot, loginSession] = await Promise.all([
    optional<CurrentSummoner>(lock, "/lol-summoner/v1/current-summoner", unavailable),
    optional<{ queueMap?: Record<string, RankedEntry> }>(lock, "/lol-ranked/v1/current-ranked-stats", unavailable),
    optional<number>(lock, "/lol-inventory/v1/wallet/lol_blue_essence", unavailable),
    optional<number>(lock, "/lol-inventory/v1/wallet/RP", unavailable),
    optional<{ honorLevel?: number }>(lock, "/lol-honor-v2/v1/profile", unavailable),
    optional<unknown[]>(lock, "/lol-champions/v1/owned-champions-minimal", unavailable),
    optional<unknown[]>(lock, "/lol-loot/v1/player-loot", unavailable),
    optional<{ isNewPlayer?: boolean; accountId?: number }>(lock, "/lol-login/v1/session", unavailable),
  ]);

  if (summoner) {
    harvest.gameName = summoner.gameName;
    harvest.tagLine = summoner.tagLine;
    harvest.summonerLevel = summoner.summonerLevel;
    harvest.profileIconId = summoner.profileIconId;
    harvest.localPuuid = summoner.puuid;
    harvest.xpPercentToNextLevel = summoner.percentCompleteForNextLevel;
  }

  if (ranked?.queueMap) {
    const solo = ranked.queueMap["RANKED_SOLO_5x5"];
    const flex = ranked.queueMap["RANKED_FLEX_SR"];
    if (solo) harvest.soloDuo = solo;
    if (flex) harvest.flex = flex;
  }

  // The wallet endpoints answer with a bare number, so 0 is a valid value — check the type,
  // not the truthiness, or a genuinely empty wallet silently disappears from the UI.
  if (typeof blueEssence === "number") harvest.blueEssence = blueEssence;
  if (typeof riotPoints === "number") harvest.riotPoints = riotPoints;
  if (typeof honor?.honorLevel === "number") harvest.honorLevel = honor.honorLevel;
  if (Array.isArray(champions)) harvest.ownedChampions = champions.length;
  if (Array.isArray(loot)) harvest.lootCount = loot.length;
  if (loginSession) harvest.restrictions = [];

  return harvest;
}

/** Is the League client up and answering? */
export async function isLcuReady(lock: Lockfile): Promise<boolean> {
  try {
    const res = await callLocalApi(lock, "GET", "/lol-summoner/v1/current-summoner", { timeoutMs: 5000 });
    return res.ok;
  } catch {
    return false;
  }
}
