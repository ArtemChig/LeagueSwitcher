/**
 * P2.1 — the public Riot API client.
 *
 * Only three things reach this file from the local client: nothing. That is deliberate.
 * puuids are encrypted per API key (RESEARCH §9) — the same account returns a completely
 * different puuid depending on which key asked. So the Riot Client's puuid is useless here, and
 * the durable identifier is the **Riot ID** (`gameName` + `tagLine`).
 *
 * Every puuid this module obtains is cached alongside a fingerprint of the key that produced
 * it. Change the key and every cached puuid is invalid — see `keyFingerprint`.
 *
 * The app must stay usable with no key at all (PLAN §8): the Riot Client already supplies Riot
 * ID, login username, region, level and profile icon, so a missing key costs rank and match
 * history, not the screen. `ApiUnavailable` is how that is signalled, distinctly from a failure.
 */
import { createHash } from "node:crypto";
import { registerSecret } from "../log/redact.js";
import { RateLimiter } from "./rateLimiter.js";
import {
  REGIONAL_FALLBACK,
  regionalFromPlatform,
  type RegionalRoute,
} from "./routing.js";

export interface RiotAccount {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export interface SummonerV4 {
  /** ⚠️ No `id` field: summonerId is retired, not deprecated (RESEARCH §9). */
  puuid: string;
  profileIconId: number;
  summonerLevel: number;
  revisionDate: number;
}

export interface LeagueEntryV4 {
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  hotStreak: boolean;
  veteran: boolean;
  freshBlood: boolean;
  inactive: boolean;
}

/** Why a call could not be made or did not succeed — each maps to a distinct UI state. */
export type ApiFailureKind =
  | "no-key"
  | "invalid-key"
  | "rate-limited"
  | "not-found"
  | "network"
  | "server"
  | "unknown";

export class RiotApiError extends Error {
  constructor(
    message: string,
    readonly kind: ApiFailureKind,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "RiotApiError";
  }

  /** True when retrying later could plausibly work. */
  get transient(): boolean {
    return this.kind === "rate-limited" || this.kind === "network" || this.kind === "server";
  }

  /** A message fit to show on a card. */
  get userMessage(): string {
    switch (this.kind) {
      case "no-key":
        return "Add a Riot API key in Settings to show rank.";
      case "invalid-key":
        return "Your Riot API key was rejected — it may have expired.";
      case "rate-limited":
        return "Riot's API is rate-limiting; this will retry shortly.";
      case "not-found":
        return "Riot has no record of this account on that region.";
      case "network":
        return "Could not reach Riot's API.";
      case "server":
        return "Riot's API is having trouble.";
      default:
        return this.message;
    }
  }
}

/** Short, stable id for a key, so cached puuids can be invalidated when the key changes. */
export function keyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

export class RiotApi {
  private readonly limiter = new RateLimiter();

  constructor(private apiKey: string | null) {
    if (apiKey) registerSecret(apiKey);
  }

  get hasKey(): boolean {
    return Boolean(this.apiKey && this.apiKey.length > 0);
  }

  get fingerprint(): string | null {
    return this.apiKey ? keyFingerprint(this.apiKey) : null;
  }

  setApiKey(key: string | null): void {
    this.apiKey = key;
    if (key) registerSecret(key);
    this.limiter.reset();
  }

  rateLimitSnapshot() {
    return this.limiter.snapshot();
  }

  /**
   * One request, rate-limited, with 429 handling.
   *
   * The key travels in the `X-Riot-Token` header, never in the query string: a URL ends up in
   * logs, in error messages and in crash reports, and a header does not.
   */
  private async get<T>(host: string, path: string, { retries = 2 }: { retries?: number } = {}): Promise<T> {
    if (!this.apiKey) throw new RiotApiError("no API key configured", "no-key");

    const url = `https://${host}.api.riotgames.com${path}`;

    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire();

      let res: Response;
      try {
        res = await fetch(url, {
          headers: { "X-Riot-Token": this.apiKey },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        if (attempt < retries) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw new RiotApiError(`network error calling ${host}${path}: ${(err as Error).message}`, "network");
      }

      const headers = Object.fromEntries(res.headers.entries());
      this.limiter.observeHeaders(headers);

      if (res.status === 429) {
        const waitMs = this.limiter.observe429(headers);
        if (attempt < retries) continue;
        throw new RiotApiError(`rate limited on ${path}`, "rate-limited", 429, waitMs);
      }

      if (res.status === 401 || res.status === 403) {
        throw new RiotApiError("API key rejected (401/403) — expired or invalid", "invalid-key", res.status);
      }
      if (res.status === 404) {
        throw new RiotApiError(`not found: ${path}`, "not-found", 404);
      }
      if (res.status >= 500) {
        if (attempt < retries) {
          await sleep(700 * (attempt + 1));
          continue;
        }
        throw new RiotApiError(`Riot API returned ${res.status}`, "server", res.status);
      }
      if (!res.ok) {
        throw new RiotApiError(`unexpected status ${res.status} from ${path}`, "unknown", res.status);
      }

      return (await res.json()) as T;
    }
  }

  // ---------------------------------------------------------------- account-v1

  /**
   * Riot ID -> account. The bootstrap call, and the only one that does not need a puuid.
   *
   * Retries once on the fallback regional route when the primary 404s: a mis-routed lookup and
   * a genuinely absent player produce the same status, and the SEA/americas split for OCE has
   * moved before (PLAN §4.4). One extra request beats a card that silently reads "not found".
   */
  async getAccountByRiotId(gameName: string, tagLine: string, route: RegionalRoute): Promise<RiotAccount> {
    const path = `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
    try {
      return await this.get<RiotAccount>(route, path);
    } catch (err) {
      const fallback = REGIONAL_FALLBACK[route];
      if (fallback && err instanceof RiotApiError && err.kind === "not-found") {
        return this.get<RiotAccount>(fallback, path);
      }
      throw err;
    }
  }

  /** puuid -> current Riot ID. Catches renames (PLAN §4.3). */
  async getAccountByPuuid(puuid: string, route: RegionalRoute): Promise<RiotAccount> {
    return this.get<RiotAccount>(route, `/riot/account/v1/accounts/by-puuid/${encodeURIComponent(puuid)}`);
  }

  // ---------------------------------------------------------------- summoner-v4

  async getSummoner(puuid: string, platform: string): Promise<SummonerV4> {
    return this.get<SummonerV4>(platform, `/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`);
  }

  // ---------------------------------------------------------------- league-v4

  /**
   * Ranked entries. An unranked account returns `[]` — that is Unranked, NOT an error
   * (RESEARCH §9). Do not let an empty array become a red card.
   */
  async getLeagueEntries(puuid: string, platform: string): Promise<LeagueEntryV4[]> {
    return this.get<LeagueEntryV4[]>(platform, `/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`);
  }

  // ---------------------------------------------------------------- match-v5

  /** Recent match ids. A brand-new account returns `[]`; the UI must handle that. */
  async getMatchIds(puuid: string, route: RegionalRoute, count = 10): Promise<string[]> {
    return this.get<string[]>(route, `/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=${count}`);
  }

  async getMatch(matchId: string, route: RegionalRoute): Promise<unknown> {
    return this.get<unknown>(route, `/lol/match/v5/matches/${encodeURIComponent(matchId)}`);
  }

  /** Cheap key validation for Settings — resolves a known-good Riot ID. */
  async validateKey(gameName: string, tagLine: string, route: RegionalRoute = "americas"): Promise<{ ok: boolean; message: string }> {
    if (!this.hasKey) return { ok: false, message: "No API key set." };
    try {
      await this.getAccountByRiotId(gameName, tagLine, route);
      return { ok: true, message: "Key works." };
    } catch (err) {
      const e = err as RiotApiError;
      // A 404 means the key worked and the Riot ID did not — still a valid key.
      if (e.kind === "not-found") return { ok: true, message: "Key works (that Riot ID was not found)." };
      return { ok: false, message: e.userMessage };
    }
  }
}

export function routeForPlatform(platform: string | null): RegionalRoute | null {
  return regionalFromPlatform(platform);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
