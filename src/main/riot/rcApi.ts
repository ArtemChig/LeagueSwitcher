/**
 * P1.2 — Riot Client local API.
 *
 * Every endpoint here was probed against the running client during Phase 0, not just found in
 * the spec. That distinction is load-bearing: EXP-2 established that the client's own
 * `/swagger/v3/openapi.json` documents routes that answer `404 RPC_ERROR "Not Found"` at
 * runtime. Anything added later must be probed the same way before it is relied on.
 */
import type { Lockfile } from "./lockfile.js";
import { callLocalApi, LocalApiError, type LocalApiResponse } from "./localApi.js";

/** Riot ID — the durable, key-independent identifier (PLAN §4.2). */
export interface RiotId {
  gameName: string;
  tagLine: string;
}

/** The subset of `/player-session-lifecycle/v1/session` this app reads. */
export interface PlayerSessionLifecycle {
  loginState: string | null;
  puuid: string | null;
  riotID: RiotId | null;
  country: string | null;
  accessToken: string | null;
  actionRequired: boolean | null;
  userInfo: {
    preferred_username?: string;
    region?: { id?: string; tag?: string; locales?: string[] };
    lol_account?: { profile_icon?: number; summoner_level?: number; summoner_name?: string };
    lol?: { cpid?: string; pid?: string; ploc?: string };
    affinity?: { pp?: string };
    original_platform_id?: string;
  } | null;
}

export interface RsoSession {
  type: "authenticated" | "needs_credentials" | "needs_password" | "needs_multifactor_verification" | "error" | "unknown_authentication_response";
  authenticationType: string | null;
  persistLogin: boolean;
  country: string;
  error: string;
}

export interface RegionLocale {
  locale: string;
  region: string;
  webLanguage: string;
  webRegion: string;
}

/**
 * Everything worth knowing about the client's login state, in one read.
 *
 * Two endpoints, because neither alone is sufficient:
 *
 *   `/rso-auth/v1/session` is authoritative, but answers `404 "RSO is not yet initialized"`
 *   until the client has finished booting. That 404 is a STATE, not an error — treating it as
 *   failure produced a false FAIL in the first EXP-1 run.
 *
 *   `/player-session-lifecycle/v1/session` answers 200 from the moment the client is up, and
 *   carries `loginState`, `riotID`, `puuid` and `userInfo` — so it separates "still booting"
 *   from "booted, sitting at the login screen", and names the account once signed in.
 */
export interface LoginState {
  /** The client is signed in as somebody. */
  authenticated: boolean;
  /** The client is up and answering, whether or not anyone is signed in. */
  reachable: boolean;
  /** True once RSO has finished starting. */
  rsoInitialised: boolean;
  rsoStatus: number | null;
  rsoType: string | null;
  loginState: string | null;
  riotId: RiotId | null;
  /**
   * The Riot Client's own puuid for this account.
   *
   * ⚠️ LOCAL ONLY. puuids are encrypted per API key (RESEARCH §9) — this value is meaningless
   * against the public API and must never be sent there. It identifies the account locally,
   * for matching a session file to a profile.
   */
  localPuuid: string | null;
  /** The login username, e.g. "accountOne" — from `userInfo.preferred_username`. */
  loginUsername: string | null;
  /** Platform ID, e.g. "NA1". EXP-4: this travels with the session. */
  platformId: string | null;
  summonerLevel: number | null;
  profileIconId: number | null;
  country: string | null;
  error?: string;
}

const EMPTY_LOGIN_STATE: LoginState = {
  authenticated: false,
  reachable: false,
  rsoInitialised: false,
  rsoStatus: null,
  rsoType: null,
  loginState: null,
  riotId: null,
  localPuuid: null,
  loginUsername: null,
  platformId: null,
  summonerLevel: null,
  profileIconId: null,
  country: null,
};

export async function readLoginState(lock: Lockfile): Promise<LoginState> {
  const state: LoginState = { ...EMPTY_LOGIN_STATE };

  try {
    const res = await callLocalApi<RsoSession & { message?: string }>(lock, "GET", "/rso-auth/v1/session");
    state.reachable = true;
    state.rsoStatus = res.status;
    state.rsoType = res.json?.type ?? null;
    state.rsoInitialised = !(res.status === 404 && /not yet initialized/i.test(res.json?.message ?? ""));
    if (res.json?.type === "authenticated") state.authenticated = true;
  } catch (err) {
    state.error = (err as Error).message;
  }

  try {
    const res = await callLocalApi<PlayerSessionLifecycle>(lock, "GET", "/player-session-lifecycle/v1/session");
    if (res.json) {
      state.reachable = true;
      const j = res.json;
      state.loginState = j.loginState ?? null;
      state.localPuuid = j.puuid ?? null;
      state.riotId = j.riotID ?? null;
      state.country = j.country ?? null;
      state.loginUsername = j.userInfo?.preferred_username ?? null;
      state.platformId = j.userInfo?.region?.id ?? j.userInfo?.original_platform_id ?? null;
      state.summonerLevel = j.userInfo?.lol_account?.summoner_level ?? null;
      state.profileIconId = j.userInfo?.lol_account?.profile_icon ?? null;
      // A populated puuid means RSO handed this client a real identity.
      if (j.puuid) state.authenticated = true;
    }
  } catch (err) {
    state.error ??= (err as Error).message;
  }

  return state;
}

export interface WaitResult {
  ok: boolean;
  state: LoginState;
  /** State transitions observed, for the switch-progress UI and for post-mortems. */
  observations: Array<{ at: string; loginState: string | null; rso: string; identified: boolean }>;
  elapsedMs: number;
}

/** Poll until the client reports a signed-in session. */
export async function waitForAuthenticated(
  lock: Lockfile,
  {
    timeoutMs = 120_000,
    intervalMs = 1000,
    onProgress,
  }: { timeoutMs?: number; intervalMs?: number; onProgress?: (state: LoginState) => void } = {}
): Promise<WaitResult> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  const observations: WaitResult["observations"] = [];
  let lastKey = "";
  let state: LoginState = { ...EMPTY_LOGIN_STATE };

  for (;;) {
    state = await readLoginState(lock);

    const key = `${state.rsoStatus}/${state.rsoType}/${state.loginState}/${Boolean(state.localPuuid)}`;
    if (key !== lastKey) {
      lastKey = key;
      observations.push({
        at: new Date().toISOString(),
        loginState: state.loginState,
        rso: `${state.rsoStatus ?? "-"}${state.rsoType ? "/" + state.rsoType : ""}`,
        identified: Boolean(state.localPuuid),
      });
      onProgress?.(state);
    }

    if (state.authenticated) return { ok: true, state, observations, elapsedMs: Date.now() - started };
    if (Date.now() >= deadline) return { ok: false, state, observations, elapsedMs: Date.now() - started };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Region and locale as the client currently has them. */
export async function getRegionLocale(lock: Lockfile): Promise<RegionLocale | null> {
  const res = await callLocalApi<RegionLocale>(lock, "GET", "/riotclient/region-locale");
  return res.ok ? res.json : null;
}

/**
 * Set region and locale at runtime.
 *
 * EXP-4 found the platform ID travels inside the session's own claims, so a switch should not
 * need this. Kept because EXP-4 could not be run across two regions on this machine — if a
 * cross-region switch turns out to land in the wrong region, this is the lever.
 */
export async function setRegionLocale(lock: Lockfile, region: string, locale = "en_US"): Promise<boolean> {
  const res = await callLocalApi(lock, "PUT", "/riotclient/region-locale", { body: { region, locale } });
  return res.ok;
}

/**
 * Prefill the username on the client's login screen — the S4 assisted-enrolment path, where
 * the user completes the captcha themselves.
 */
export async function setAuthHint(lock: Lockfile, username: string): Promise<boolean> {
  const res = await callLocalApi(lock, "POST", "/rso-auth/v1/auth-hints/hint", { body: { hint: username } });
  return res.ok;
}

export async function clearAuthHint(lock: Lockfile): Promise<boolean> {
  const res = await callLocalApi(lock, "DELETE", "/rso-auth/v1/auth-hints/hint");
  return res.ok;
}

/**
 * S2 hot-swap: inject a refresh token into a running client.
 *
 * ⚠️ EXP-2: this returns `404 RPC_ERROR "Not Found"` on the current client build, in BOTH the
 * signed-out and signed-in states, despite being fully documented in the spec. The code is kept
 * because the route may return, and because a switch is only ~2s via S1 anyway — but callers
 * MUST treat failure as normal and fall back to S1. `available` distinguishes "the route is
 * gone" from "the token was rejected".
 */
export interface InjectResult {
  available: boolean;
  authorized: boolean;
  type: string | null;
  status: number;
  message: string | null;
}

export async function injectRefreshToken(
  lock: Lockfile,
  { refreshToken, idToken, isDpopBound = false }: { refreshToken: string; idToken?: string | null; isDpopBound?: boolean }
): Promise<InjectResult> {
  let res: LocalApiResponse<{ type?: string; message?: string }>;
  try {
    res = await callLocalApi(lock, "PUT", "/rso-auth/v1/authorization/refresh-token", {
      body: {
        refresh_token: refreshToken,
        id_token: idToken ?? "",
        is_dpop_bound: isDpopBound,
        permissions: [],
      },
    });
  } catch (err) {
    return { available: false, authorized: false, type: null, status: 0, message: (err as Error).message };
  }

  const message = res.json?.message ?? null;
  const routeMissing = res.status === 404 && /^not found$/i.test((message ?? "").trim());

  return {
    available: !routeMissing,
    authorized: res.json?.type === "authorized",
    type: res.json?.type ?? null,
    status: res.status,
    message,
  };
}

/**
 * S3b: the legacy direct-credentials login.
 *
 * EXP-3 confirmed the route IS implemented (it answered 400 "No previous RSO session found",
 * not 404), but whether it bypasses hCaptcha is unknown — settling that needs a real credential
 * and one attempt under hard rule 9. Callers must respect `retryAfter` and must NEVER loop.
 */
export interface CredentialLoginResult {
  available: boolean;
  type: string | null;
  status: number;
  error: string | null;
  retryAfter: number | null;
  message: string | null;
}

export async function loginWithCredentials(
  lock: Lockfile,
  { username, password, region = "", persistLogin = true }: { username: string; password: string; region?: string; persistLogin?: boolean }
): Promise<CredentialLoginResult> {
  const res = await callLocalApi<{ type?: string; error?: string; retryAfter?: number; message?: string }>(
    lock,
    "PUT",
    "/rso-auth/v1/session/credentials",
    { body: { username, password, region, persistLogin } }
  );

  const message = res.json?.message ?? null;
  return {
    available: !(res.status === 404 && /^not found$/i.test((message ?? "").trim())),
    type: res.json?.type ?? null,
    status: res.status,
    error: res.json?.error ?? null,
    retryAfter: res.json?.retryAfter ?? null,
    message,
  };
}

/** Pull the live OpenAPI spec. Hard rule 6 — but remember the spec is a superset of reality. */
export async function fetchOpenApiSpec(lock: Lockfile): Promise<{ paths: Record<string, unknown> } | null> {
  const res = await callLocalApi<{ paths: Record<string, unknown> }>(lock, "GET", "/swagger/v3/openapi.json", {
    timeoutMs: 30_000,
  });
  return res.ok ? res.json : null;
}

export { LocalApiError };
