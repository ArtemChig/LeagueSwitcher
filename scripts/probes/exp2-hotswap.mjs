/**
 * EXP-2 — hot refresh-token injection.
 *
 *   node scripts/probes/exp2-hotswap.mjs [--dry-run]
 *
 * Question: can a RUNNING, signed-out Riot Client be authenticated by injecting a stored
 * refresh token, with no kill-and-relaunch? If yes, a switch is ~2s instead of ~15s (PLAN §3 S2).
 *
 * The spec's own summary for the endpoint is "Restore a player's refresh token along with an
 * id token to refill some claims for the authorization" — which is exactly this use case.
 *
 * DESIGN NOTE — why this does NOT call DELETE /rso-auth/v1/session:
 *   The obvious test is "log out, then inject". It is not run, deliberately. A logout may
 *   revoke the refresh token SERVER-side, and this machine has exactly one enrolled account.
 *   Restoring the file cannot undo a server-side revocation, so that test could leave the only
 *   proven session dead until someone signs in by hand through a captcha. Instead the client is
 *   started with a WIPED session file, which reaches the same signed-out state with nothing
 *   revoked — and EXP-1 already proved a file restore recovers it.
 *
 * Whatever happens, the cleanup block at the end restores the captured session and relaunches,
 * so the machine is left signed in.
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PATHS, captureSession, describeLock, isGameRunning, killRiotProcesses, launchRiotClient,
  localApi, log, readLoginState, readSessionSecrets, restoreSession, summariseSession, sleep,
  waitForAuthenticated, waitForRcLockfile, writeResult,
} from "./lib/riotlocal.mjs";

const dryRun = process.argv.includes("--dry-run");
/**
 * --authenticated-only: skip the wipe entirely and PUT into the client as it stands, signed in.
 * The signed-out run answers "can a logged-out client be filled from a token" (it cannot — the
 * whole /rso-auth surface 404s until RSO initialises). This mode answers the different and more
 * useful question: "is the endpoint reachable at all once RSO IS up?" — which is the state a real
 * account-to-account switch would inject from.
 */
const authenticatedOnly = process.argv.includes("--authenticated-only");

const EMPTY_SESSION = ["psl:", "    authorization: null", "riot-login:", "    persist: null", ""].join("\n");
const result = { probe: "exp2-hotswap", dryRun, steps: [] };
const step = (name, data) => { result.steps.push({ name, at: new Date().toISOString(), ...data }); return data; };

let capturedFile = null;

async function cleanup(note) {
  log(`\n== cleanup (${note}) ==`);
  if (!capturedFile) { log("  nothing captured — leaving the machine as-is"); return; }
  try {
    killRiotProcesses();
    await sleep(2000);
    restoreSession(capturedFile);
    log("  session restored from the capture");
    launchRiotClient();
    const lock = await waitForRcLockfile(120000);
    if (!lock) { log("  !! client did not come back up — restore by hand from the baseline"); return; }
    const auth = await waitForAuthenticated(lock, 90000, 2000);
    step("cleanup-auth", { ok: auth.ok, loginState: auth.state?.loginState });
    log(`  client back up and ${auth.ok ? "signed in" : "NOT signed in — check by hand"}`);
    result.leftSignedIn = auth.ok;
  } catch (err) {
    log(`  !! cleanup failed: ${err.message}`);
    result.cleanupError = err.message;
  }
}

// ---------------------------------------------------------------- preflight

log("== EXP-2 preflight ==");
if (isGameRunning()) { log("  League of Legends.exe is running — refusing"); process.exit(1); }

const backups = existsSync(PATHS.backups) ? readdirSync(PATHS.backups).filter((d) => d.startsWith("baseline-")) : [];
if (backups.length === 0) { log("  no baseline snapshot — hard rule 1 forbids proceeding"); process.exit(1); }
log(`  baseline present: ${backups.sort().at(-1)}`);

const before = summariseSession();
if (!before.present || !before.hasAuthorization) {
  log("  the live session file holds no refresh_token — sign in first, then re-run");
  process.exit(1);
}
log(`  live session: write_count=${before.refreshTokenWriteCount}, refresh fp=${before.refreshToken.fp}`);

if (dryRun) { log("\n-- dry run, no writes --"); log(`recorded -> ${writeResult("exp2-hotswap", { ...result, verdict: "DRY-RUN" })}`); process.exit(0); }

// ---------------------------------------------------------------- capture

const captureDir = join(PATHS.appRoot, "probe-sessions");
mkdirSync(captureDir, { recursive: true });
capturedFile = join(captureDir, `exp2-capture-${Date.now()}.yaml`);
captureSession(capturedFile);
step("captured", { file: capturedFile });
log(`\n== captured session -> ${capturedFile}`);

const secrets = readSessionSecrets(capturedFile);
if (!secrets?.refreshToken) { log("  could not read a refresh_token out of the capture"); await cleanup("no token"); process.exit(1); }
log(`  token lengths: refresh=${secrets.refreshToken.length} id=${secrets.idToken?.length ?? 0} dpopBound=${secrets.isDpopBound}`);

try {
  // ------------------------------------------------------------ signed-out client

  let lock;
  if (authenticatedOnly) {
    log("\n== injecting into the client as it stands (signed in, RSO initialised) ==");
    lock = await waitForRcLockfile(15000);
    if (!lock) {
      log("  no client running — launching one");
      launchRiotClient();
      lock = await waitForRcLockfile(120000);
      if (!lock) throw new Error("no lockfile within 120s");
    }
    const up = await waitForAuthenticated(lock, 120000, 2000);
    step("preinject-state", { ok: up.ok, loginState: up.state?.loginState });
    log(`  lockfile: ${describeLock(lock)}`);
    log(`  authenticated=${up.ok} loginState=${up.state?.loginState}`);
    if (!up.ok) throw new Error("client is not signed in; --authenticated-only needs a live session");
  } else {
    log("\n== bringing up a signed-out client (wiped session, nothing revoked) ==");
    killRiotProcesses();
    await sleep(2000);
    writeFileSync(PATHS.rcSession, EMPTY_SESSION, "utf8");
    launchRiotClient();

    lock = await waitForRcLockfile(120000);
    if (!lock) throw new Error("no lockfile within 120s");
    log(`  lockfile: ${describeLock(lock)}`);

    // Wait for the client to finish booting — the local API 404s with
    // "RSO is not yet initialized" until it has, and injecting before that is meaningless.
    let booted = null;
    for (let i = 0; i < 30; i++) {
      booted = await readLoginState(lock);
      if (booted.loginState) break;
      await sleep(2000);
    }
    step("signed-out-state", booted);
    log(`  loginState=${booted.loginState} authenticated=${booted.authenticated}`);
    if (booted.authenticated) throw new Error("client authenticated with a wiped session — cannot test injection from here");
  }

  // ------------------------------------------------------------ the injection

  log("\n== PUT /rso-auth/v1/authorization/refresh-token ==");
  const t0 = Date.now();
  const res = await localApi(lock, "PUT", "/rso-auth/v1/authorization/refresh-token", {
    refresh_token: secrets.refreshToken,
    id_token: secrets.idToken ?? "",
    is_dpop_bound: secrets.isDpopBound,
    permissions: [],
  });
  const elapsed = Date.now() - t0;

  const type = res.json?.type ?? null;
  step("inject", {
    mode: authenticatedOnly ? "authenticated" : "signed-out",
    status: res.status,
    type,
    errorCode: res.json?.errorCode ?? null,
    message: res.json?.message ?? null,
    deletionReason: res.json?.deletionReason ?? null,
    country: res.json?.country ?? null,
    hasAuthorization: Boolean(res.json?.authorization),
    elapsedMs: elapsed,
  });
  log(`  -> ${res.status} type=${type} in ${elapsed}ms`);
  if (res.json?.message) log(`     message: ${res.json.errorCode ?? ""} ${res.json.message}`);
  if (res.json?.deletionReason) log(`     deletionReason=${res.json.deletionReason}`);
  if (!res.json) log(`     body: ${res.text.slice(0, 300)}`);

  // ------------------------------------------------------------ did it take?

  log("\n== did the client actually become signed in? ==");
  const after = await waitForAuthenticated(lock, 45000, 2000);
  step("post-inject", { ok: after.ok, loginState: after.state?.loginState, observations: after.observations });
  for (const o of after.observations) log(`  ${o.at}  rso=${o.rso}  loginState=${o.loginState}  identified=${o.identified}`);

  result.injectionAccepted = type === "authorized";
  result.clientSignedIn = after.ok;
  result.totalMs = Date.now() - t0;
  result.signedInAs = after.state?.riotID ? `${after.state.riotID.gameName}#${after.state.riotID.tagLine}` : null;

  // The injection must be judged by the endpoint's OWN answer, never by "is the client signed
  // in afterwards". In --authenticated-only mode the client was already signed in before the
  // PUT, so post-state tells us nothing — an earlier version of this probe read that as a PASS
  // while the endpoint was in fact answering 404.
  if (!result.injectionAccepted) {
    result.verdict = "FAIL";
    result.reason = `injection returned status ${res.status} type=${type}` +
      (res.json?.message ? ` (${res.json.errorCode}: ${res.json.message})` : "");
    log(`\n== EXP-2 FAIL — ${result.reason}`);
    log("   S1 cold swap remains the switch path. Leave the S2 hot-swap setting off.");
  } else if (authenticatedOnly) {
    result.verdict = "PARTIAL";
    result.reason = "endpoint accepted the token, but this mode re-injected the SAME account into " +
      "an already-signed-in client, so it does not prove an account-to-account hot swap";
    log(`\n== EXP-2 PARTIAL — endpoint returned 'authorized'. Needs a second account to prove a real swap ==`);
  } else if (after.ok) {
    result.verdict = "PASS";
    log(`\n== EXP-2 PASS — a signed-out client was authenticated by injection alone ` +
        `(${result.signedInAs}, ${result.totalMs}ms, no relaunch) ==`);
  } else {
    result.verdict = "PARTIAL";
    result.reason = "endpoint returned 'authorized' but the client never reported a signed-in session";
    log(`\n== EXP-2 PARTIAL — token accepted but the session did not come up ==`);
  }
} catch (err) {
  result.verdict = "FAIL";
  result.reason = err.message;
  log(`\n!! EXP-2 error: ${err.message}`);
} finally {
  await cleanup("restoring the machine");
  log(`\nrecorded -> ${writeResult("exp2-hotswap", result)}`);
}

process.exit(result.verdict === "PASS" ? 0 : 1);
