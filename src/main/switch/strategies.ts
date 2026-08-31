/**
 * P1.6 — the switch ladder, and the enrolment ladder beside it.
 *
 * What Phase 0 settled, and what it means here:
 *
 *   S1 cold swap — PROVEN (EXP-1). Capture, stop the client, restore the target session,
 *      relaunch, poll. Measured at ~2.1s to `authenticated`, far under the 10-15s budgeted.
 *      This is the workhorse and, for now, the only switch path.
 *   S2 hot inject — DEAD on this build (EXP-2). The endpoint 404s in every client state despite
 *      being fully documented in the spec. Attempted only when explicitly enabled, and any
 *      failure falls straight through to S1. Since S1 is ~2s, there is little left to win.
 *   S3 password login — the route exists (EXP-3 got 400, not 404) but whether it clears
 *      hCaptcha is unknown. Used for enrolment only, capped at ONE attempt per call.
 *   S4 assisted enrolment — the path that cannot break. Prefill the username, let the user
 *      clear the captcha, watch for the session to appear, harvest it.
 *
 * Every step reports progress through an event callback, because a switch with no feedback
 * feels broken even when it is fast (PLAN §5).
 */
import { readLockfile, waitForLockfile } from "../riot/lockfile.js";
import {
  getVanguardStatus,
  isGameRunning,
  isLeagueClientRunning,
  launchRiotClient,
  shutdownRiot,
  type VanguardStatus,
} from "../riot/process.js";
import { existsSync } from "node:fs";
import { riotPaths } from "../riot/paths.js";
import {
  captureSession,
  diffSessions,
  readSessionRaw,
  readSessionSecrets,
  restoreSessionFromString,
  summariseSession,
  validateSessionFile,
  type SessionSummary,
} from "../riot/session.js";
import {
  injectRefreshToken,
  readLoginState,
  waitForAuthenticated,
  type LoginState,
} from "../riot/rcApi.js";
import { getAccountStore, regionFromPlatform, type Account } from "../store/accounts.js";
import { getVault } from "../store/vault.js";

export type SwitchStep =
  | "preflight"
  | "capturing-current"
  | "stopping-client"
  | "restoring-session"
  | "launching-client"
  | "waiting-for-login"
  | "recapturing"
  | "updating-profile"
  | "done";

export interface SwitchProgress {
  step: SwitchStep;
  message: string;
  detail?: string;
}

export type ProgressFn = (progress: SwitchProgress) => void;

export interface SwitchOptions {
  /** Set by the UI once the user has confirmed signing the current account out. */
  confirmedCloseRunningClient?: boolean;
  /** Try S2 first. Defaults to false — EXP-2 says it does not work on this build. */
  allowHotSwap?: boolean;
  onProgress?: ProgressFn;
  timeoutMs?: number;
}

export interface SwitchResult {
  ok: boolean;
  accountId: string;
  strategy: "S1" | "S2" | null;
  elapsedMs: number;
  /** Set when the switch was refused before anything was touched. */
  refusedReason?: string;
  /** Set when the caller must confirm and retry. */
  needsConfirmation?: boolean;
  error?: string;
  loginState?: LoginState;
  capturedPrevious?: boolean;
  recaptured?: boolean;
}

const noop: ProgressFn = () => {};

/**
 * P4.3 — everything that could stop or complicate a switch, gathered before one starts.
 *
 * Separate from `switchToAccount` so the UI can grey out a card, or word its confirmation
 * dialog properly, without starting anything. The switch itself re-checks the blocking
 * conditions rather than trusting a preflight that may be seconds stale.
 */
export interface Preflight {
  /** Hard stop — the switch will be refused. */
  canSwitch: boolean;
  blockers: Array<{ code: "game-in-progress" | "not-enrolled" | "bad-session" | "riot-missing"; message: string }>;
  /** Needs an explicit yes, but is not a refusal. */
  confirmations: Array<{ code: "client-running"; message: string }>;
  /** Worth saying, but nothing stops. */
  notes: string[];
  vanguard: VanguardStatus;
}

export async function preflightSwitch(accountId: string): Promise<Preflight> {
  const store = getAccountStore();
  const vault = await getVault();

  const result: Preflight = {
    canSwitch: true,
    blockers: [],
    confirmations: [],
    notes: [],
    vanguard: { serviceRunning: false, driverLoaded: false, active: false },
  };

  if (!existsSync(riotPaths.rcServices)) {
    result.blockers.push({
      code: "riot-missing",
      message: `RiotClientServices.exe was not found at ${riotPaths.rcServices}.`,
    });
  }

  if (await isGameRunning()) {
    result.blockers.push({
      code: "game-in-progress",
      message: "A game is in progress. Switching would disconnect you from it.",
    });
  }

  const account = store.get(accountId);
  if (!account) {
    result.blockers.push({ code: "not-enrolled", message: `No account with id "${accountId}".` });
  } else {
    const stored = await vault.getSession(accountId);
    if (!stored) {
      result.blockers.push({
        code: "not-enrolled",
        message: `${account.loginUsername} has no stored session. Enrol it before switching.`,
      });
    } else {
      // Validate the decrypted content without writing it anywhere.
      const secrets = parseSecretsFromYaml(stored);
      if (!secrets.refreshToken || secrets.refreshToken.length < 100) {
        result.blockers.push({
          code: "bad-session",
          message: `${account.loginUsername}'s stored session has no usable token — re-enrol it.`,
        });
      }
      if (secrets.isDpopBound) {
        result.blockers.push({
          code: "bad-session",
          message: `${account.loginUsername}'s token is device-bound and will not transfer.`,
        });
      }
    }

    if (account.sessionDaysRemaining !== null && account.sessionDaysRemaining < 30) {
      result.notes.push(
        `${account.loginUsername}'s session expires in ${account.sessionDaysRemaining} days — switch to it soon or re-enrol.`
      );
    }
  }

  if (await isLeagueClientRunning()) {
    const activeId = store.getActiveId();
    const activeName = activeId ? (store.get(activeId)?.loginUsername ?? activeId) : "the current account";
    result.confirmations.push({
      code: "client-running",
      message: `The League client is open. ${activeName} will be signed out.`,
    });
  }

  result.vanguard = await getVanguardStatus();
  if (result.vanguard.active) {
    result.notes.push("Riot Vanguard is running. It does not block a switch, but League may need a reboot to launch.");
  }

  result.canSwitch = result.blockers.length === 0;
  return result;
}

/**
 * Switch to an enrolled account.
 *
 * Order is chosen so nothing is destroyed before its replacement is known to be good:
 *   1. refuse outright if a game is running
 *   2. confirm before closing a running League client
 *   3. verify the TARGET session decrypts and is plausible — before touching anything
 *   4. capture the CURRENT session into its own vault entry (hard rule: capture before overwrite)
 *   5. only then stop, restore and relaunch
 */
export async function switchToAccount(accountId: string, options: SwitchOptions = {}): Promise<SwitchResult> {
  const { onProgress = noop, allowHotSwap = false, confirmedCloseRunningClient = false } = options;
  const started = Date.now();
  const store = getAccountStore();
  const vault = await getVault();

  const fail = (error: string, extra: Partial<SwitchResult> = {}): SwitchResult => ({
    ok: false,
    accountId,
    strategy: null,
    elapsedMs: Date.now() - started,
    error,
    ...extra,
  });

  // ---------------------------------------------------------------- preflight

  onProgress({ step: "preflight", message: "Checking it is safe to switch" });

  const account = store.get(accountId);
  if (!account) return fail(`no account with id "${accountId}"`);

  // A game in progress is refused outright, never merely warned about (PLAN §3 S1).
  if (await isGameRunning()) {
    return fail("A game is in progress. Switching now would disconnect you from it.", {
      refusedReason: "game-in-progress",
    });
  }

  if ((await isLeagueClientRunning()) && !confirmedCloseRunningClient) {
    const active = store.getActiveId();
    const activeName = active ? (store.get(active)?.loginUsername ?? active) : "the current account";
    return fail(`The League client is open and ${activeName} will be signed out.`, {
      refusedReason: "client-running",
      needsConfirmation: true,
    });
  }

  // Verify the target BEFORE destroying the current session. A target that will not decrypt
  // must not cost the user the session they already had.
  const targetYaml = await vault.getSession(accountId);
  if (!targetYaml) {
    return fail(
      `No stored session for ${account.loginUsername}. Enrol this account before switching to it.`,
      { refusedReason: "not-enrolled" }
    );
  }

  // ---------------------------------------------------------------- capture the current session

  let capturedPrevious = false;
  const currentSummary = summariseSession();

  if (currentSummary.present && currentSummary.signedIn) {
    onProgress({ step: "capturing-current", message: "Saving the current session first" });
    const raw = readSessionRaw();
    if (raw) {
      // Who this session belongs to must be OBSERVED, never remembered.
      //
      // This used to read `store.getActiveId()` first and only fall back to identifying the
      // live session. That is backwards: activeAccountId is a UI hint that goes stale, while
      // the signed-in client is ground truth. When the two disagreed, this wrote the live
      // session under a different account's key and destroyed that account's stored session.
      //
      // Observed for real: activeAccountId still said accountFour while the client was signed
      // in as accountTwo. Switching then overwrote accountFour's stored session with
      // accountTwo's, so "switch accountFour" signed in as accountTwo — reporting success
      // the whole way. The session was unrecoverable; only the password remained.
      //
      // So: write under an account id only when the live session is positively identified as
      // that account. Anything else is parked under an unclaimed id, which costs a little
      // disk and cannot destroy a session.
      const identified = await identifyCurrentAccount(store);
      const ownerId = identified?.id ?? null;

      if (ownerId && ownerId !== accountId) {
        await vault.putSession(ownerId, raw);
        capturedPrevious = true;
      } else if (!ownerId) {
        await vault.putSession(`unclaimed-${Date.now()}`, raw);
        capturedPrevious = true;
      }
    }
  }

  // ---------------------------------------------------------------- S2, if asked for

  if (allowHotSwap) {
    const lock = readLockfile("riot-client");
    if (lock) {
      const secrets = parseSecretsFromYaml(targetYaml);
      if (secrets.refreshToken) {
        onProgress({ step: "restoring-session", message: "Trying a fast in-place switch" });
        const injected = await injectRefreshToken(lock, {
          refreshToken: secrets.refreshToken,
          idToken: secrets.idToken,
          isDpopBound: secrets.isDpopBound,
        });
        if (injected.authorized) {
          const auth = await waitForAuthenticated(lock, { timeoutMs: 30_000 });
          if (auth.ok) {
            await finishSwitch(accountId, auth.state, store, vault, onProgress);
            return {
              ok: true,
              accountId,
              strategy: "S2",
              elapsedMs: Date.now() - started,
              loginState: auth.state,
              capturedPrevious,
              recaptured: true,
            };
          }
        }
        onProgress({
          step: "restoring-session",
          message: "Fast switch unavailable, using the standard path",
          detail: injected.available ? `client answered ${injected.type ?? injected.status}` : "endpoint not implemented on this client build",
        });
      }
    }
  }

  // ---------------------------------------------------------------- S1 cold swap

  onProgress({ step: "stopping-client", message: "Closing the Riot Client" });
  const shutdown = await shutdownRiot({ includeLeague: true });
  if (shutdown.gameWasRunning) {
    return fail("A game started while the switch was preparing. Nothing was changed.", {
      refusedReason: "game-in-progress",
    });
  }
  if (shutdown.survivors.length > 0) {
    return fail(
      `Could not close: ${shutdown.survivors.map((p) => `${p.name} (pid ${p.pid})`).join(", ")}. ` +
        "Nothing was changed — close them by hand and try again."
    );
  }

  onProgress({ step: "restoring-session", message: `Restoring ${account.loginUsername}'s session` });
  let restored: SessionSummary;
  try {
    restored = restoreSessionFromString(targetYaml);
  } catch (err) {
    return fail(`The stored session for ${account.loginUsername} is unusable: ${(err as Error).message}`, {
      refusedReason: "bad-session",
    });
  }

  onProgress({ step: "launching-client", message: "Starting the Riot Client" });
  try {
    // No product argument: the switch ends at the Riot Client (EXP-7, PLAN §8).
    launchRiotClient();
  } catch (err) {
    return fail((err as Error).message);
  }

  const lock = await waitForLockfile("riot-client", { timeoutMs: 120_000 });
  if (!lock) {
    return fail("The Riot Client did not start within two minutes. Your session has been restored — start it by hand.");
  }

  onProgress({ step: "waiting-for-login", message: "Waiting for sign-in" });
  const auth = await waitForAuthenticated(lock, {
    timeoutMs: options.timeoutMs ?? 120_000,
    onProgress: (state) => {
      onProgress({
        step: "waiting-for-login",
        message: describeLoginState(state),
        detail: state.loginState ?? undefined,
      });
    },
  });

  if (!auth.ok) {
    // The session may have been invalidated server-side — the health flag drives the UI's
    // "needs re-enrolment" state rather than leaving the user guessing.
    store.update(accountId, { sessionHealth: "missing", lastError: "Stored session did not sign in" });
    return fail(
      `${account.loginUsername}'s stored session did not sign in. It has probably expired — re-enrol this account.`,
      { loginState: auth.state, capturedPrevious }
    );
  }

  const recaptured = await finishSwitch(accountId, auth.state, store, vault, onProgress, restored);

  return {
    ok: true,
    accountId,
    strategy: "S1",
    elapsedMs: Date.now() - started,
    loginState: auth.state,
    capturedPrevious,
    recaptured,
  };
}

/**
 * After a successful sign-in: re-capture the session and write back what the client told us
 * about the account.
 *
 * EXP-5 found that signing in rotates `id_token` and bumps `refresh_token_write_count` while
 * the `refresh_token` itself stays put. So re-capturing is a freshness measure rather than a
 * correctness one — but it is cheap, and it keeps the stored copy in step with the server.
 */
async function finishSwitch(
  accountId: string,
  state: LoginState,
  store: ReturnType<typeof getAccountStore>,
  vault: Awaited<ReturnType<typeof getVault>>,
  onProgress: ProgressFn,
  before?: SessionSummary
): Promise<boolean> {
  onProgress({ step: "recapturing", message: "Saving the refreshed session" });

  let recaptured = false;
  const after = summariseSession();
  if (before) {
    const diff = diffSessions(before, after);
    onProgress({
      step: "recapturing",
      message: "Saving the refreshed session",
      detail: `id_token ${diff.idTokenRotated ? "rotated" : "unchanged"}, write_count ${diff.writeCountDelta ?? "?"}`,
    });
  }
  const raw = readSessionRaw();
  if (raw && validateSessionFile(riotPaths.session).valid) {
    await vault.putSession(accountId, raw);
    recaptured = true;
  }

  onProgress({ step: "updating-profile", message: "Updating account details" });

  // Everything below comes from the local client — no API key needed (RESEARCH §7 bonus finding).
  store.update(accountId, {
    gameName: state.riotId?.gameName ?? null,
    tagLine: state.riotId?.tagLine ?? null,
    platformId: state.platformId,
    region: regionFromPlatform(state.platformId),
    localPuuid: state.localPuuid,
    loginUsername: state.loginUsername ?? store.get(accountId)?.loginUsername ?? accountId,
    summonerLevel: state.summonerLevel,
    profileIconId: state.profileIconId,
    lastSwitchedAt: new Date().toISOString(),
    sessionHealth: "valid",
    sessionDaysRemaining: after.daysUntilExpiry,
    lastError: null,
  });
  store.setActive(accountId);

  onProgress({ step: "done", message: "Switched" });
  return recaptured;
}

/**
 * Capture whatever is signed in right now into the vault, creating the profile if it is new.
 *
 * This is the enrolment completion step for every ladder rung: however the user got signed in,
 * this is what turns it into an account the app can switch to.
 */
export interface CaptureResult {
  ok: boolean;
  accountId?: string;
  account?: Account;
  error?: string;
  created?: boolean;
}

export async function captureCurrentSession(options: { label?: string } = {}): Promise<CaptureResult> {
  const store = getAccountStore();
  const vault = await getVault();

  const lock = readLockfile("riot-client");
  if (!lock) return { ok: false, error: "The Riot Client is not running. Start it and sign in first." };

  const state = await readLoginState(lock);
  if (!state.authenticated) {
    return { ok: false, error: `The Riot Client is not signed in (${state.loginState ?? "unknown state"}).` };
  }

  const validation = validateSessionFile(riotPaths.session);
  if (!validation.valid) {
    return { ok: false, error: `The live session file is not usable: ${validation.reasons.join("; ")}` };
  }

  const loginUsername = state.loginUsername ?? state.riotId?.gameName ?? "unknown";
  const id = accountIdFor(loginUsername);

  const existing = store.get(id);
  const account =
    existing ??
    store.upsert({
      id,
      loginUsername,
      gameName: state.riotId?.gameName ?? null,
      tagLine: state.riotId?.tagLine ?? null,
      platformId: state.platformId,
      region: regionFromPlatform(state.platformId),
      localPuuid: state.localPuuid,
      puuid: null,
      puuidKeyFingerprint: null,
      summonerLevel: state.summonerLevel,
      profileIconId: state.profileIconId,
      ranked: [],
      label: options.label ?? null,
      colorTag: null,
      order: store.list().length,
      enrolledAt: new Date().toISOString(),
      lastSwitchedAt: null,
      lastUpdated: null,
      lastError: null,
      sessionHealth: "valid",
      sessionDaysRemaining: validation.summary.daysUntilExpiry,
    });

  const raw = readSessionRaw();
  if (!raw) return { ok: false, error: "Could not read the live session file." };
  await vault.putSession(id, raw);

  store.update(id, {
    gameName: state.riotId?.gameName ?? account.gameName,
    tagLine: state.riotId?.tagLine ?? account.tagLine,
    platformId: state.platformId ?? account.platformId,
    region: regionFromPlatform(state.platformId) ?? account.region,
    localPuuid: state.localPuuid ?? account.localPuuid,
    summonerLevel: state.summonerLevel ?? account.summonerLevel,
    profileIconId: state.profileIconId ?? account.profileIconId,
    sessionHealth: "valid",
    sessionDaysRemaining: validation.summary.daysUntilExpiry,
    enrolledAt: account.enrolledAt ?? new Date().toISOString(),
    lastError: null,
  });
  store.setActive(id);

  return { ok: true, accountId: id, account: store.get(id) ?? account, created: !existing };
}

/**
 * S4 — assisted enrolment. The rung that cannot break.
 *
 * Signs the client out (by writing a signed-out session, never by calling logout — a logout may
 * revoke the refresh token server-side), prefills the username, and waits for the user to clear
 * the captcha. The moment the client reports a session, it is harvested.
 *
 * The current session is captured first, so starting an enrolment can never cost the user the
 * account they were already signed in as.
 */
export async function beginAssistedEnrolment(
  username: string,
  { onProgress = noop, timeoutMs = 300_000 }: { onProgress?: ProgressFn; timeoutMs?: number } = {}
): Promise<CaptureResult> {
  const vault = await getVault();
  const store = getAccountStore();

  if (await isGameRunning()) {
    return { ok: false, error: "A game is in progress. Finish it before enrolling an account." };
  }

  onProgress({ step: "capturing-current", message: "Saving the current session first" });
  const current = summariseSession();
  if (current.present && current.signedIn) {
    const raw = readSessionRaw();
    // Identify, never assume — see the note in switchToAccount. Trusting the remembered
    // active id here would overwrite that account's stored session with someone else's.
    const ownerId = (await identifyCurrentAccount(store))?.id ?? `unclaimed-${Date.now()}`;
    if (raw) await vault.putSession(ownerId, raw);
  }

  onProgress({ step: "stopping-client", message: "Closing the Riot Client" });
  const shutdown = await shutdownRiot({ includeLeague: true });
  if (shutdown.survivors.length > 0) {
    return { ok: false, error: `Could not close ${shutdown.survivors.map((p) => p.name).join(", ")}.` };
  }

  onProgress({ step: "restoring-session", message: "Preparing a clean sign-in" });
  const { SIGNED_OUT_SESSION } = await import("../riot/session.js");
  restoreSessionFromString(SIGNED_OUT_SESSION, { allowInvalid: true });

  onProgress({ step: "launching-client", message: "Starting the Riot Client" });
  launchRiotClient();

  const lock = await waitForLockfile("riot-client", { timeoutMs: 120_000 });
  if (!lock) return { ok: false, error: "The Riot Client did not start." };

  // No prefill is possible.
  //
  // This used to POST the username to /rso-auth/v1/auth-hints/hint and promise the field would
  // be filled in. That endpoint has nothing to do with usernames: its body is
  // { context, required, type } where type is one of email_verification, password_reset,
  // parental_consent, ambiguous_username, alias_change_required. Nothing in the client's API
  // populates the sign-in form, which is a webview.
  //
  // So the username goes to the clipboard instead and the message says what is actually true.
  let copied = false;
  try {
    const { clipboard } = await import("electron");
    clipboard.writeText(username);
    copied = true;
  } catch {
    // Not running under Electron (the CLI). The message below still names the username.
  }

  onProgress({
    step: "waiting-for-login",
    message: copied
      ? `Sign in as ${username} — it is on your clipboard, so paste it. The session is captured automatically.`
      : `Sign in as ${username} in the Riot Client — the session will be captured automatically`,
  });

  const auth = await waitForAuthenticated(lock, { timeoutMs, intervalMs: 2000 });
  if (!auth.ok) return { ok: false, error: "Timed out waiting for sign-in." };

  return captureCurrentSession();
}

/** Match the live session against known accounts using the local puuid. */
async function identifyCurrentAccount(store: ReturnType<typeof getAccountStore>): Promise<Account | null> {
  const lock = readLockfile("riot-client");
  if (!lock) return null;
  try {
    const state = await readLoginState(lock);
    const accounts = store.list();

    // localPuuid is the strongest signal — stable, and unique per account.
    if (state.localPuuid) {
      const byPuuid = accounts.find((a) => a.localPuuid === state.localPuuid);
      if (byPuuid) return byPuuid;
    }

    // Fall back to the login username the client reports. Weaker, but still observed rather
    // than remembered, and it rescues accounts enrolled before localPuuid was recorded.
    if (state.loginUsername) {
      const needle = state.loginUsername.trim().toLowerCase();
      const byUsername = accounts.find((a) => a.loginUsername.trim().toLowerCase() === needle);
      if (byUsername) return byUsername;
    }

    return null;
  } catch {
    return null;
  }
}

function describeLoginState(state: LoginState): string {
  if (state.authenticated) return "Signed in";
  switch (state.loginState) {
    case "PendingLoginStrategy":
      return "At the sign-in screen";
    case "PendingProductContext":
      return "Signing in";
    case null:
      return "Starting the client";
    default:
      return `Signing in (${state.loginState})`;
  }
}

/** Pull token values straight out of a decrypted session, for the S2 injection path. */
function parseSecretsFromYaml(yaml: string): { refreshToken: string | null; idToken: string | null; isDpopBound: boolean } {
  const pick = (key: string) => {
    const m = yaml.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m"));
    if (!m?.[1]) return null;
    const v = m[1].replace(/^"|"$/g, "");
    return v === "null" ? null : v;
  };
  return {
    refreshToken: pick("refresh_token"),
    idToken: pick("id_token"),
    isDpopBound: /is_dpop_bound:\s*true/.test(yaml),
  };
}

function accountIdFor(username: string): string {
  return username.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "account";
}
