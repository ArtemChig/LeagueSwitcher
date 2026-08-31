/**
 * P2.6 — opportunistic enrichment from whatever is signed in right now.
 *
 * Two sources, both local, neither requiring an API key:
 *
 *   Riot Client — Riot ID, login username, platform, level, profile icon. Available whenever
 *                 the client is up, which is most of the time. This is the source that makes
 *                 the app usable with no API key at all (RESEARCH §7).
 *   League (LCU) — the extras the public API does not expose: BE/RP, honour, owned champions,
 *                 loot, and ranked stats. Only available while League is actually open, so it
 *                 is strictly a bonus.
 *
 * "Opportunistic" is the whole contract. Nothing here is required for correctness, so every
 * step is allowed to fail and the result reports what was and was not obtained.
 */
import { readLockfile } from "../riot/lockfile.js";
import { readLoginState } from "../riot/rcApi.js";
import { harvestFromLcu, type LcuHarvest } from "../riot/lcuApi.js";
import { summariseSession } from "../riot/session.js";
import { getAccountStore, regionFromPlatform, type Account, type RankEntry } from "../store/accounts.js";

export interface CollectionResult {
  /** The account that was enriched, if one could be identified. */
  accountId: string | null;
  fromRiotClient: boolean;
  fromLcu: boolean;
  /** Fields actually written back. */
  updated: string[];
  /** Why a source contributed nothing. Not errors — expected states. */
  notes: string[];
  lcu?: LcuHarvest;
}

/**
 * Harvest whatever is available for the signed-in account and write it into the store.
 *
 * Matching is by local puuid first (exact), then by login username. The local puuid is
 * key-scoped and useless against the public API, but it is precisely the right identifier for
 * "which of my profiles is this machine currently signed in as".
 */
export async function collectForCurrentAccount(): Promise<CollectionResult> {
  const store = getAccountStore();
  const result: CollectionResult = {
    accountId: null,
    fromRiotClient: false,
    fromLcu: false,
    updated: [],
    notes: [],
  };

  const rcLock = readLockfile("riot-client");
  if (!rcLock) {
    result.notes.push("The Riot Client is not running, so nothing could be collected.");
    return result;
  }

  const state = await readLoginState(rcLock);
  if (!state.authenticated) {
    result.notes.push(`The Riot Client is not signed in (${state.loginState ?? "starting"}).`);
    return result;
  }
  result.fromRiotClient = true;

  const account =
    (state.localPuuid ? store.list().find((a) => a.localPuuid === state.localPuuid) : null) ??
    (state.loginUsername
      ? store.list().find((a) => a.loginUsername.toLowerCase() === state.loginUsername!.toLowerCase())
      : null) ??
    null;

  if (!account) {
    result.notes.push(
      `Signed in as ${state.riotId ? `${state.riotId.gameName}#${state.riotId.tagLine}` : "an account"} ` +
        "that is not enrolled — run capture to add it."
    );
    return result;
  }

  result.accountId = account.id;

  // ---------------------------------------------------------------- Riot Client fields

  const changes: Partial<Account> = {};
  const note = (field: keyof Account, value: unknown) => {
    if (value !== null && value !== undefined && value !== account[field]) {
      (changes as Record<string, unknown>)[field] = value;
      result.updated.push(field);
    }
  };

  note("gameName", state.riotId?.gameName ?? null);
  note("tagLine", state.riotId?.tagLine ?? null);
  note("platformId", state.platformId);
  note("region", regionFromPlatform(state.platformId));
  note("localPuuid", state.localPuuid);
  note("summonerLevel", state.summonerLevel);
  note("profileIconId", state.profileIconId);
  if (state.loginUsername) note("loginUsername", state.loginUsername);

  // Session health, from the file rather than the API: this is what drives the card's dot.
  const session = summariseSession();
  if (session.present && session.signedIn) {
    const days = session.daysUntilExpiry;
    changes.sessionHealth = days !== null && days < 30 ? "stale" : "valid";
    changes.sessionDaysRemaining = days;
    result.updated.push("sessionHealth");
  }

  // ---------------------------------------------------------------- LCU extras

  const lcuLock = readLockfile("lcu");
  if (!lcuLock) {
    result.notes.push("League is not running, so BE/RP, honour and loot were not collected.");
  } else {
    const harvest = await harvestFromLcu(lcuLock);
    result.fromLcu = true;
    result.lcu = harvest;

    // The LCU is authoritative for ranked while it is open, and needs no API key — so it fills
    // the one gap a missing key leaves on the card.
    const ranked: RankEntry[] = [];
    if (harvest.soloDuo) {
      ranked.push({
        queue: "RANKED_SOLO_5x5",
        tier: harvest.soloDuo.tier,
        rank: harvest.soloDuo.division,
        leaguePoints: harvest.soloDuo.leaguePoints,
        wins: harvest.soloDuo.wins,
        losses: harvest.soloDuo.losses,
      });
    }
    if (harvest.flex) {
      ranked.push({
        queue: "RANKED_FLEX_SR",
        tier: harvest.flex.tier,
        rank: harvest.flex.division,
        leaguePoints: harvest.flex.leaguePoints,
        wins: harvest.flex.wins,
        losses: harvest.flex.losses,
      });
    }
    if (ranked.length > 0) {
      changes.ranked = ranked;
      result.updated.push("ranked");
    }

    if (harvest.unavailable.length > 0) {
      result.notes.push(`${harvest.unavailable.length} League endpoint(s) were unavailable — those fields are blank.`);
    }
  }

  if (result.updated.length > 0) {
    changes.lastUpdated = new Date().toISOString();
    store.update(account.id, changes);
  }

  return result;
}

/**
 * Refresh session health for every account without touching the network.
 *
 * P4.4's proactive "needs re-enrolment" flag. Health here is about the STORED session: an
 * account with no stored session cannot be switched to at all, which the grid must show before
 * the user clicks and fails.
 */
export async function refreshSessionHealth(
  hasStoredSession: (accountId: string) => boolean
): Promise<Array<{ accountId: string; health: Account["sessionHealth"] }>> {
  const store = getAccountStore();
  const out: Array<{ accountId: string; health: Account["sessionHealth"] }> = [];

  for (const account of store.list()) {
    let health: Account["sessionHealth"];

    if (!hasStoredSession(account.id)) {
      health = "missing";
    } else if (account.sessionDaysRemaining !== null && account.sessionDaysRemaining < 30) {
      // The token is valid for ~453 days between restores, so "under a month left" means the
      // account has not been switched to in well over a year.
      health = "stale";
    } else {
      health = "valid";
    }

    if (health !== account.sessionHealth) store.update(account.id, { sessionHealth: health });
    out.push({ accountId: account.id, health });
  }

  return out;
}
