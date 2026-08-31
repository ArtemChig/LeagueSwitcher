/**
 * P2.2 / P2.3 — launch-time refresh for every account at once.
 *
 * The requirement (PLAN §4): every card shows fresh data on launch, without switching to any
 * account. So this runs across all accounts in parallel, and the governing rule is that
 * **one account failing must never block the others** — every account is wrapped so a thrown
 * error becomes that account's error state and nothing more.
 *
 * P2.3, the puuid bootstrap, lives here because it is a precondition of every other call:
 *
 *   puuids are encrypted per API key. A cached puuid is only meaningful to the key that issued
 *   it, so each is stored with a fingerprint of that key. If the key changes, every cached
 *   puuid is silently wrong — not missing, WRONG — and must be re-resolved from the Riot ID.
 *   That check is the first thing `refreshAccount` does.
 */
import type { Account, RankEntry } from "../store/accounts.js";
import { getAccountStore } from "../store/accounts.js";
import { getVault } from "../store/vault.js";
import { RiotApi, RiotApiError, keyFingerprint } from "./riotApi.js";
import { platformFromPlatformId, platformFromRegion, regionalFromPlatform } from "./routing.js";

export interface AccountRefreshResult {
  accountId: string;
  ok: boolean;
  /** Set when the account could not be refreshed. Shown on that card only. */
  error?: string;
  errorKind?: string;
  /** True when a puuid had to be resolved because the API key changed (or was never resolved). */
  resolvedPuuid?: boolean;
  /** True when Riot reports a different Riot ID than we had stored — a rename. */
  renamed?: boolean;
  elapsedMs: number;
}

export interface RefreshSummary {
  ran: boolean;
  /** Why the whole refresh did not run, when it did not. */
  skippedReason?: "no-key" | "no-accounts";
  results: AccountRefreshResult[];
  succeeded: number;
  failed: number;
  elapsedMs: number;
}

export interface RefreshOptions {
  /** Refresh only these ids. Defaults to all. */
  accountIds?: string[];
  /** How many recent matches to pull ids for. 0 skips match-v5 entirely. */
  matchCount?: number;
  onAccountDone?: (result: AccountRefreshResult) => void;
}

/**
 * Refresh every account. Resolves even when everything fails — the caller renders states,
 * it does not catch exceptions.
 */
export async function refreshAllAccounts(options: RefreshOptions = {}): Promise<RefreshSummary> {
  const started = Date.now();
  const store = getAccountStore();
  const vault = await getVault();

  const all = store.list();
  const targets = options.accountIds ? all.filter((a) => options.accountIds!.includes(a.id)) : all;

  if (targets.length === 0) {
    return { ran: false, skippedReason: "no-accounts", results: [], succeeded: 0, failed: 0, elapsedMs: 0 };
  }

  const apiKey = vault.getApiKey();
  if (!apiKey) {
    // Not a failure. The client-sourced fields (Riot ID, region, level, icon) are already on
    // the cards; only rank and match history are missing. PLAN §8 requires this stay usable.
    return {
      ran: false,
      skippedReason: "no-key",
      results: targets.map((a) => ({
        accountId: a.id,
        ok: false,
        error: "No Riot API key configured",
        errorKind: "no-key",
        elapsedMs: 0,
      })),
      succeeded: 0,
      failed: targets.length,
      elapsedMs: Date.now() - started,
    };
  }

  const api = new RiotApi(apiKey);

  // Parallel, but the rate limiter serialises the actual sends, so this is safe at any width.
  const results = await Promise.all(
    targets.map(async (account) => {
      const result = await refreshAccount(api, account, options);
      options.onAccountDone?.(result);
      return result;
    })
  );

  return {
    ran: true,
    results,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Refresh one account. Never throws — every failure is captured into the result and written to
 * the account's `lastError`, so the UI can show a per-card retry.
 */
export async function refreshAccount(
  api: RiotApi,
  account: Account,
  { matchCount = 0 }: RefreshOptions = {}
): Promise<AccountRefreshResult> {
  const started = Date.now();
  const store = getAccountStore();
  const fingerprint = api.fingerprint;

  const fail = (err: unknown): AccountRefreshResult => {
    const e = err instanceof RiotApiError ? err : new RiotApiError(String((err as Error).message ?? err), "unknown");
    store.update(account.id, { lastError: e.userMessage, lastUpdated: new Date().toISOString() });
    return {
      accountId: account.id,
      ok: false,
      error: e.userMessage,
      errorKind: e.kind,
      elapsedMs: Date.now() - started,
    };
  };

  // ---------------------------------------------------------------- routing

  const platform =
    platformFromPlatformId(account.platformId) ?? platformFromRegion(account.region) ?? null;
  if (!platform) {
    return fail(
      new RiotApiError(
        "This account has no region yet. Switch to it once and the client will report it.",
        "unknown"
      )
    );
  }
  const route = regionalFromPlatform(platform);
  if (!route) return fail(new RiotApiError(`no regional route for platform ${platform}`, "unknown"));

  // ---------------------------------------------------------------- P2.3 puuid bootstrap

  let puuid = account.puuid;
  let resolvedPuuid = false;

  // The fingerprint check is the whole point: a puuid cached under a different key is not
  // stale, it is wrong, and it would resolve to somebody else's data or a 404.
  const cacheValid = puuid !== null && account.puuidKeyFingerprint === fingerprint;

  if (!cacheValid) {
    if (!account.gameName || !account.tagLine) {
      return fail(
        new RiotApiError(
          "No Riot ID for this account yet. Switch to it once — the Riot Client reports its own Riot ID.",
          "unknown"
        )
      );
    }
    try {
      const resolved = await api.getAccountByRiotId(account.gameName, account.tagLine, route);
      puuid = resolved.puuid;
      resolvedPuuid = true;
      store.update(account.id, {
        puuid,
        puuidKeyFingerprint: fingerprint,
        gameName: resolved.gameName,
        tagLine: resolved.tagLine,
      });
    } catch (err) {
      return fail(err);
    }
  }

  if (!puuid) return fail(new RiotApiError("could not resolve a puuid", "unknown"));

  // ---------------------------------------------------------------- the refresh itself

  let renamed = false;
  const changes: Partial<Account> = { lastUpdated: new Date().toISOString(), lastError: null };

  // Rename detection is best-effort: a rename is cosmetic, and failing it must not cost the
  // level and rank that follow.
  if (!resolvedPuuid) {
    try {
      const current = await api.getAccountByPuuid(puuid, route);
      if (current.gameName !== account.gameName || current.tagLine !== account.tagLine) {
        renamed = true;
        changes.gameName = current.gameName;
        changes.tagLine = current.tagLine;
      }
    } catch {
      /* keep the stored Riot ID */
    }
  }

  try {
    const summoner = await api.getSummoner(puuid, platform);
    changes.summonerLevel = summoner.summonerLevel;
    changes.profileIconId = summoner.profileIconId;
  } catch (err) {
    return fail(err);
  }

  try {
    const entries = await api.getLeagueEntries(puuid, platform);
    // An empty array is Unranked, not a failure (RESEARCH §9).
    changes.ranked = entries
      .filter((e) => e.queueType === "RANKED_SOLO_5x5" || e.queueType === "RANKED_FLEX_SR")
      .map(
        (e): RankEntry => ({
          queue: e.queueType as RankEntry["queue"],
          tier: e.tier,
          rank: e.rank,
          leaguePoints: e.leaguePoints,
          wins: e.wins,
          losses: e.losses,
          hotStreak: e.hotStreak,
          veteran: e.veteran,
          freshBlood: e.freshBlood,
          inactive: e.inactive,
        })
      );
  } catch (err) {
    // Rank is the least essential field here — level and icon are already fetched, so record
    // the problem and keep what we have rather than discarding the whole refresh.
    const e = err as RiotApiError;
    changes.lastError = e.userMessage;
  }

  if (matchCount > 0) {
    try {
      await api.getMatchIds(puuid, route, matchCount);
    } catch {
      /* the form strip is optional */
    }
  }

  store.update(account.id, changes);

  return {
    accountId: account.id,
    ok: true,
    resolvedPuuid,
    renamed,
    elapsedMs: Date.now() - started,
  };
}

export { keyFingerprint };
