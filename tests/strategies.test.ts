/**
 * P4.6 — the switch ladder's safety properties.
 *
 * These are the rules that matter more than any feature, so they are asserted rather than
 * trusted to review:
 *
 *   - a game in progress is REFUSED, not warned about
 *   - an open League client needs explicit confirmation, naming who gets signed out
 *   - the target session is verified BEFORE anything is touched, so a bad target cannot cost
 *     the user the session they already had
 *   - the current session is captured BEFORE it is overwritten
 *   - nothing is restored while processes are still alive
 *
 * The collaborators are mocked because the real ones kill processes and rewrite the machine's
 * live login. What is under test here is the decision logic and, crucially, the ORDER — which
 * is asserted explicitly with a call log, since ordering is exactly what a refactor breaks
 * silently.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Every side-effecting call, in the order it happened. */
const calls: string[] = [];

const state = {
  gameRunning: false,
  leagueClientRunning: false,
  storedSession: "psl:\n  refresh_token: " + "r".repeat(300) + "\n",
  liveSessionSignedIn: true,
  authSucceeds: true,
  survivors: [] as Array<{ pid: number; name: string }>,
};

vi.mock("../src/main/riot/process.js", () => ({
  isGameRunning: vi.fn(async () => state.gameRunning),
  isLeagueClientRunning: vi.fn(async () => state.leagueClientRunning),
  getVanguardStatus: vi.fn(async () => ({ serviceRunning: false, driverLoaded: false, active: false })),
  shutdownRiot: vi.fn(async () => {
    calls.push("shutdown");
    return { reports: [], survivors: state.survivors, gameWasRunning: state.gameRunning };
  }),
  launchRiotClient: vi.fn(() => {
    calls.push("launch");
    return { exe: "RiotClientServices.exe", args: [], pid: 1 };
  }),
  RIOT_CLIENT_PROCESSES: [],
  LEAGUE_CLIENT_PROCESSES: [],
  GAME_PROCESS: "League of Legends",
}));

vi.mock("../src/main/riot/lockfile.js", () => ({
  readLockfile: vi.fn(() => ({ port: 1, password: "x", protocol: "https" })),
  waitForLockfile: vi.fn(async () => ({ port: 1, password: "x", protocol: "https" })),
}));

vi.mock("../src/main/riot/rcApi.js", () => ({
  readLoginState: vi.fn(async () => ({ authenticated: true, localPuuid: "local-1", loginUsername: "User" })),
  waitForAuthenticated: vi.fn(async () => ({
    ok: state.authSucceeds,
    state: {
      authenticated: state.authSucceeds,
      riotId: { gameName: "Name", tagLine: "TAG" },
      localPuuid: "local-1",
      loginUsername: "User",
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
    present: true,
    signedIn: state.liveSessionSignedIn,
    sha256: "abc",
    daysUntilExpiry: 400,
    refreshToken: { length: 300, fingerprint: "aaa" },
    idToken: { length: 100, fingerprint: "bbb" },
    tdid: null,
    refreshTokenWriteCount: 1,
  })),
  readSessionRaw: vi.fn(() => "live-session-yaml"),
  restoreSessionFromString: vi.fn(() => {
    calls.push("restore");
    return { present: true, signedIn: true, sha256: "def", daysUntilExpiry: 400, refreshToken: null, idToken: null };
  }),
  validateSessionFile: vi.fn(() => ({ valid: true, reasons: [], summary: {} })),
  diffSessions: vi.fn(() => ({ changed: true, idTokenRotated: true, writeCountDelta: 1, shouldRecapture: true })),
  captureSession: vi.fn(),
  readSessionSecrets: vi.fn(() => ({ refreshToken: "r".repeat(300), idToken: null, isDpopBound: false })),
  SIGNED_OUT_SESSION: "psl:\n  authorization: null\n",
}));

const putSession = vi.fn(async (id: string) => {
  calls.push(`capture:${id}`);
});

vi.mock("../src/main/store/vault.js", () => ({
  getVault: vi.fn(async () => ({
    getSession: vi.fn(async () => state.storedSession),
    putSession,
    hasSession: () => true,
    hasCredential: () => false,
    getCredential: () => null,
  })),
}));

const updates: Array<Record<string, unknown>> = [];

vi.mock("../src/main/store/accounts.js", () => ({
  getAccountStore: vi.fn(() => ({
    get: (id: string) => (id === "target" || id === "current" ? { id, loginUsername: id, ranked: [], sessionDaysRemaining: 400 } : null),
    list: () => [
      { id: "current", loginUsername: "current", localPuuid: "local-1", ranked: [] },
      { id: "target", loginUsername: "target", localPuuid: "local-2", ranked: [] },
    ],
    getActiveId: () => "current",
    setActive: vi.fn(),
    update: vi.fn((id: string, changes: Record<string, unknown>) => {
      updates.push({ id, ...changes });
      return { id, loginUsername: id, ranked: [] };
    }),
    upsert: vi.fn((a: unknown) => a),
  })),
  regionFromPlatform: (p: string | null) => (p === "NA1" ? "NA" : null),
}));

const { switchToAccount, preflightSwitch } = await import("../src/main/switch/strategies.js");

beforeEach(() => {
  calls.length = 0;
  updates.length = 0;
  putSession.mockClear();
  state.gameRunning = false;
  state.leagueClientRunning = false;
  state.storedSession = "psl:\n  refresh_token: " + "r".repeat(300) + "\n";
  state.liveSessionSignedIn = true;
  state.authSucceeds = true;
  state.survivors = [];
});

describe("a game in progress is refused outright", () => {
  it("refuses, and touches nothing", async () => {
    state.gameRunning = true;
    const result = await switchToAccount("target");

    expect(result.ok).toBe(false);
    expect(result.refusedReason).toBe("game-in-progress");
    // The important half: no shutdown, no restore, no launch.
    expect(calls).toEqual([]);
  });

  it("is a refusal rather than something a confirmation can override", async () => {
    state.gameRunning = true;
    const result = await switchToAccount("target", { confirmedCloseRunningClient: true });
    expect(result.ok).toBe(false);
    expect(result.refusedReason).toBe("game-in-progress");
    expect(calls).toEqual([]);
  });
});

describe("an open League client needs confirmation", () => {
  it("stops and asks, naming the account that would be signed out", async () => {
    state.leagueClientRunning = true;
    const result = await switchToAccount("target");

    expect(result.ok).toBe(false);
    expect(result.needsConfirmation).toBe(true);
    expect(result.error).toContain("current");
    expect(calls).toEqual([]);
  });

  it("proceeds once confirmed", async () => {
    state.leagueClientRunning = true;
    const result = await switchToAccount("target", { confirmedCloseRunningClient: true });

    expect(result.ok).toBe(true);
    expect(calls).toContain("shutdown");
  });
});

describe("the target is verified before anything is touched", () => {
  it("refuses when the account has no stored session, changing nothing", async () => {
    state.storedSession = null as unknown as string;
    const result = await switchToAccount("target");

    expect(result.ok).toBe(false);
    expect(result.refusedReason).toBe("not-enrolled");
    expect(calls).toEqual([]);
  });

  it("refuses an unknown account", async () => {
    const result = await switchToAccount("nobody");
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("ordering — the property a refactor breaks silently", () => {
  it("captures the current session BEFORE shutting down or restoring", async () => {
    const result = await switchToAccount("target");
    expect(result.ok).toBe(true);

    // The exact sequence a safe cold swap must follow.
    expect(calls).toEqual([
      "capture:current", // the outgoing account's session is saved first
      "shutdown",        // only then is anything closed
      "restore",         // only then is the file overwritten
      "launch",
      "capture:target",  // re-captured after sign-in (EXP-5: the file changes)
    ]);
  });

  it("does not restore while processes survive the shutdown", async () => {
    state.survivors = [{ pid: 42, name: "LeagueClient" }];
    const result = await switchToAccount("target", { confirmedCloseRunningClient: true });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("LeagueClient");
    expect(calls).toContain("shutdown");
    // The critical assertion: nothing was written while something was still holding on.
    expect(calls).not.toContain("restore");
  });

  it("skips capturing when the live session is signed out — there is nothing to save", async () => {
    state.liveSessionSignedIn = false;
    await switchToAccount("target");
    expect(calls.filter((c) => c === "capture:current")).toHaveLength(0);
    expect(calls).toContain("restore");
  });
});

describe("a session that does not sign in", () => {
  it("reports it and flags the account for re-enrolment rather than failing silently", async () => {
    state.authSucceeds = false;
    const result = await switchToAccount("target");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("re-enrol");
    expect(updates.some((u) => u.sessionHealth === "missing")).toBe(true);
  });
});

describe("preflight reports without doing anything", () => {
  it("blocks on a game in progress", async () => {
    state.gameRunning = true;
    const pre = await preflightSwitch("target");

    expect(pre.canSwitch).toBe(false);
    expect(pre.blockers.map((b) => b.code)).toContain("game-in-progress");
    expect(calls).toEqual([]);
  });

  it("asks for confirmation, without blocking, when League is open", async () => {
    state.leagueClientRunning = true;
    const pre = await preflightSwitch("target");

    expect(pre.canSwitch).toBe(true); // a confirmation is not a blocker
    expect(pre.confirmations.map((c) => c.code)).toContain("client-running");
  });

  it("blocks a stored session with no usable token", async () => {
    state.storedSession = "psl:\n  refresh_token: tiny\n";
    const pre = await preflightSwitch("target");

    expect(pre.canSwitch).toBe(false);
    expect(pre.blockers.map((b) => b.code)).toContain("bad-session");
  });

  it("is clean when nothing is in the way", async () => {
    const pre = await preflightSwitch("target");
    expect(pre.canSwitch).toBe(true);
    expect(pre.blockers).toEqual([]);
    expect(calls).toEqual([]);
  });
});
