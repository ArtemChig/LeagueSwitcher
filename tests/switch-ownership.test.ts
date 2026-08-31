/**
 * Regression: a switch must never write the live session under the wrong account.
 *
 * The bug this pins down destroyed real data. Before switching, `switchToAccount` saves the
 * currently signed-in session so it is not lost — but it decided WHOSE session that was by
 * reading `store.getActiveId()`, the app's own memory of who is signed in, and only fell back
 * to identifying the live client if that memory was empty.
 *
 * That is backwards. activeAccountId is a UI hint and goes stale; the signed-in client is
 * ground truth. When they disagreed, the live session was written under a different account's
 * key, overwriting that account's stored session with someone else's.
 *
 * Observed: activeAccountId still said accountFour while the client was signed in as
 * accountTwo. The next switch wrote accountTwo's session over accountFour's, so
 * "switch accountFour" then signed in as accountTwo — reporting success at every step.
 * accountFour's session was unrecoverable; only its stored password survived.
 *
 * The rule these tests hold: write under an account id only when the live session is
 * positively identified as that account. Otherwise park it under an unclaimed id, which wastes
 * a little disk and cannot destroy anything.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  /** What the app *remembers* about who is signed in — may be stale or wrong. */
  activeId: "alice" as string | null,
  /** What the client actually *reports* — ground truth. */
  livePuuid: "puuid-alice" as string | null,
  liveUsername: "alice" as string | null,
};

const captures: string[] = [];

/**
 * Only the captures made BEFORE the client is stopped. Re-capturing the target afterwards is
 * correct and expected; it is the pre-switch save — the one that can overwrite someone else's
 * stored session — that these tests are about.
 */
const preSwitchCaptures = () => captures.slice(0, captures.indexOf("--- switched ---"));

vi.mock("../src/main/riot/process.js", () => ({
  isGameRunning: vi.fn(async () => false),
  isLeagueClientRunning: vi.fn(async () => false),
  getVanguardStatus: vi.fn(async () => ({ serviceRunning: false, driverLoaded: false, active: false })),
  shutdownRiot: vi.fn(async () => { captures.push("--- switched ---"); return { reports: [], survivors: [], gameWasRunning: false }; }),
  launchRiotClient: vi.fn(() => ({ exe: "x", args: [], pid: 1 })),
  RIOT_CLIENT_PROCESSES: [],
  LEAGUE_CLIENT_PROCESSES: [],
  GAME_PROCESS: "League of Legends",
}));

vi.mock("../src/main/riot/lockfile.js", () => ({
  readLockfile: vi.fn(() => ({ port: 1, password: "x", protocol: "https" })),
  waitForLockfile: vi.fn(async () => ({ port: 1, password: "x", protocol: "https" })),
}));

vi.mock("../src/main/riot/rcApi.js", () => ({
  readLoginState: vi.fn(async () => ({
    authenticated: true,
    localPuuid: state.livePuuid,
    loginUsername: state.liveUsername,
  })),
  waitForAuthenticated: vi.fn(async () => ({
    ok: true,
    state: {
      authenticated: true,
      riotId: { gameName: "Name", tagLine: "TAG" },
      localPuuid: "puuid-bob",
      loginUsername: "bob",
      platformId: "NA1",
      summonerLevel: 30,
      profileIconId: 1,
      loginState: "PendingProductContext",
    },
    observations: [],
    elapsedMs: 10,
  })),
  injectRefreshToken: vi.fn(async () => ({ available: false, authorized: false, type: null, status: 404, message: "Not Found" })),
  setAuthHint: vi.fn(async () => true),
}));

vi.mock("../src/main/riot/session.js", () => ({
  summariseSession: vi.fn(() => ({
    present: true, signedIn: true, sha256: "abc", daysUntilExpiry: 400,
    refreshToken: { length: 300, fingerprint: "aaa" }, idToken: { length: 100, fingerprint: "bbb" },
    tdid: null, refreshTokenWriteCount: 1,
  })),
  readSessionRaw: vi.fn(() => "live-session-yaml"),
  restoreSessionFromString: vi.fn(() => ({ present: true, signedIn: true, sha256: "def", daysUntilExpiry: 400, refreshToken: null, idToken: null })),
  validateSessionFile: vi.fn(() => ({ valid: true, reasons: [], summary: {} })),
  diffSessions: vi.fn(() => ({ changed: false, idTokenRotated: false, writeCountDelta: 0, shouldRecapture: false })),
  captureSession: vi.fn(),
  readSessionSecrets: vi.fn(() => ({ refreshToken: "r".repeat(300), idToken: null, isDpopBound: false })),
  SIGNED_OUT_SESSION: "psl:\n  authorization: null\n",
}));

vi.mock("../src/main/store/vault.js", () => ({
  getVault: vi.fn(async () => ({
    getSession: vi.fn(async () => "psl:\n  refresh_token: " + "r".repeat(300) + "\n"),
    putSession: vi.fn(async (id: string) => { captures.push(id); }),
    hasSession: () => true,
    hasCredential: () => false,
    getCredential: () => null,
  })),
}));

vi.mock("../src/main/store/accounts.js", () => ({
  getAccountStore: vi.fn(() => ({
    get: (id: string) => (["alice", "bob"].includes(id) ? { id, loginUsername: id, ranked: [], sessionDaysRemaining: 400 } : null),
    list: () => [
      { id: "alice", loginUsername: "alice", localPuuid: "puuid-alice", ranked: [] },
      { id: "bob", loginUsername: "bob", localPuuid: "puuid-bob", ranked: [] },
    ],
    getActiveId: () => state.activeId,
    setActive: vi.fn(),
    update: vi.fn((id: string) => ({ id, loginUsername: id, ranked: [] })),
    upsert: vi.fn((a: unknown) => a),
  })),
  regionFromPlatform: (p: string | null) => (p === "NA1" ? "NA" : null),
}));

const { switchToAccount } = await import("../src/main/switch/strategies.js");

beforeEach(() => {
  captures.length = 0;
  state.activeId = "alice";
  state.livePuuid = "puuid-alice";
  state.liveUsername = "alice";
});

describe("whose session is being saved", () => {
  it("saves under the account the client reports, not the one remembered", async () => {
    // The app thinks alice is signed in. The client says it is really bob.
    state.activeId = "alice";
    state.livePuuid = "puuid-bob";
    state.liveUsername = "bob";

    // Switching to alice must NOT write bob's live session over alice's stored one.
    await switchToAccount("alice", { confirmedCloseRunningClient: true });

    expect(preSwitchCaptures()).toEqual(["bob"]);
  });

  it("does not touch any real account when the live session cannot be identified", async () => {
    state.activeId = "alice";
    state.livePuuid = "puuid-nobody";
    state.liveUsername = "nobody";

    await switchToAccount("bob", { confirmedCloseRunningClient: true });

    const pre = preSwitchCaptures();
    expect(pre).not.toContain("alice");
    expect(pre).not.toContain("bob");
    expect(pre.some((c) => c.startsWith("unclaimed-"))).toBe(true);
  });

  it("still saves the previous account when memory and reality agree", async () => {
    state.activeId = "alice";
    state.livePuuid = "puuid-alice";
    state.liveUsername = "alice";

    await switchToAccount("bob", { confirmedCloseRunningClient: true });

    expect(preSwitchCaptures()).toEqual(["alice"]);
  });

  it("identifies by login username when the puuid is unavailable", async () => {
    state.activeId = null;
    state.livePuuid = null;
    state.liveUsername = "alice";

    await switchToAccount("bob", { confirmedCloseRunningClient: true });

    expect(preSwitchCaptures()).toEqual(["alice"]);
  });

  it("never writes the live session under the account being switched to", async () => {
    state.activeId = "bob";
    state.livePuuid = "puuid-bob";
    state.liveUsername = "bob";

    // Switching to bob while bob is signed in: capturing under "bob" would be harmless here,
    // but the guard exists so a mis-identification cannot overwrite the target's good session
    // with whatever happens to be live.
    await switchToAccount("bob", { confirmedCloseRunningClient: true });

    // Nothing at all should be saved beforehand: the live session already belongs to the
    // target, so there is no previous account whose session needs preserving.
    expect(preSwitchCaptures()).toEqual([]);
  });
});
