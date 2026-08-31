/**
 * EXP-1 — cold session swap round-trip, using the SAME account.
 *
 *   node scripts/probes/exp1-cold-swap.mjs [--skip-negative] [--dry-run]
 *
 * Proves the core mechanism of the whole app with zero risk of cross-account
 * contamination: if restoring a captured RiotGamesPrivateSettings.yaml makes the Riot
 * Client sign in by itself, every switch after enrolment is a file copy.
 *
 * Sequence (default):
 *   1. refuse if a game is running
 *   2. capture the live session          -> %APPDATA%\LeagueSwitcher\probe-sessions\
 *   3. kill every Riot/League process
 *   4. NEGATIVE CONTROL: wipe the session, launch, confirm the client is NOT signed in
 *      (without this the test cannot tell "restore worked" from "it was never gone")
 *   5. kill again, restore the captured session, launch
 *   6. poll /rso-auth/v1/session for type == "authenticated"
 *   7. re-summarise the session file so EXP-5 (token rotation) falls out of the same run
 *
 * Safety: the baseline snapshot under %APPDATA%\LeagueSwitcher\backups\ is verified to
 * exist before anything is written, and the live session is captured before it is touched.
 * Nothing is ever deleted — the "wipe" writes a structurally valid empty session.
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PATHS, captureSession, describeLock, isGameRunning, killRiotProcesses,
  launchRiotClient, listRiotProcesses, log, readRcLockfile, restoreSession,
  summariseSession, sleep, waitForAuthenticated, waitForRcLockfile, writeResult,
} from "./lib/riotlocal.mjs";

const args = new Set(process.argv.slice(2));
const skipNegative = args.has("--skip-negative");
const dryRun = args.has("--dry-run");

/** A structurally valid but signed-out session file. Used for the negative control. */
const EMPTY_SESSION = [
  "psl:",
  "    authorization: null",
  "riot-login:",
  "    persist: null",
  "",
].join("\n");

const result = { probe: "exp1-cold-swap", steps: [], dryRun, skipNegative };
const step = (name, data) => {
  result.steps.push({ name, at: new Date().toISOString(), ...data });
  return data;
};

function fail(reason, extra = {}) {
  result.verdict = "FAIL";
  result.reason = reason;
  Object.assign(result, extra);
  log(`\n!! EXP-1 FAIL — ${reason}`);
  log(`recorded -> ${writeResult("exp1-cold-swap", result)}`);
  process.exit(1);
}

// ---------------------------------------------------------------- preflight

log("== EXP-1 preflight ==");

if (isGameRunning()) {
  fail("League of Legends.exe is running — refusing to touch the session (PLAN §3 S1)");
}
log("  no game in progress");

const backupDirs = existsSync(PATHS.backups)
  ? readdirSync(PATHS.backups).filter((d) => d.startsWith("baseline-"))
  : [];
if (backupDirs.length === 0) {
  fail("no baseline-* snapshot under " + PATHS.backups + " — hard rule 1 forbids proceeding");
}
step("baseline-verified", { snapshots: backupDirs });
log(`  baseline snapshot present: ${backupDirs.sort().at(-1)}`);

const before = summariseSession();
if (!before.present) fail("no live session file to capture at " + PATHS.rcSession);
if (!before.hasAuthorization) {
  fail("the live session file has no refresh_token — nothing is signed in, so a round-trip proves nothing");
}
step("before", { session: before });
log(`  live session: ${before.bytes} bytes, write_count=${before.refreshTokenWriteCount}, ` +
    `refresh fp=${before.refreshToken.fp}`);

if (dryRun) {
  result.verdict = "DRY-RUN";
  log("\n-- dry run, stopping before any write --");
  log(`recorded -> ${writeResult("exp1-cold-swap", result)}`);
  process.exit(0);
}

// ---------------------------------------------------------------- 2. capture

const captureDir = join(PATHS.appRoot, "probe-sessions");
mkdirSync(captureDir, { recursive: true });
const capturedFile = join(captureDir, `exp1-capture-${Date.now()}.yaml`);
captureSession(capturedFile);
step("captured", { file: capturedFile, sha256: before.sha256 });
log(`\n== captured live session -> ${capturedFile}`);

// ---------------------------------------------------------------- 3. kill

log("\n== stopping Riot processes ==");
const kill1 = killRiotProcesses();
step("kill-1", kill1);
log(`  stopped: ${kill1.alreadyClear ? "(nothing was running)" : kill1.stopped.join(", ")}`);
if (kill1.survivors?.length) log(`  !! survivors: ${kill1.survivors.join(", ")}`);
await sleep(2500);

// Does the client rewrite the session on its way out? If it does, the app must always
// restore AFTER the processes are confirmed dead, never before.
const afterKill = summariseSession();
step("session-after-kill", { session: afterKill });
const rewroteOnExit = afterKill.sha256 !== before.sha256;
result.clientRewritesSessionOnExit = rewroteOnExit;
log(`  session file after shutdown: ${rewroteOnExit ? "REWRITTEN by the client on exit" : "unchanged"}` +
    ` (${afterKill.bytes} bytes, write_count=${afterKill.refreshTokenWriteCount})`);

// ---------------------------------------------------------------- 4. negative control

if (!skipNegative) {
  log("\n== NEGATIVE CONTROL: wipe session, launch, expect NOT authenticated ==");
  writeFileSync(PATHS.rcSession, EMPTY_SESSION, "utf8");
  const wiped = summariseSession();
  step("wiped", { session: wiped });
  log(`  session wiped -> ${wiped.bytes} bytes, hasAuthorization=${wiped.hasAuthorization}`);

  launchRiotClient();
  log("  launched RiotClientServices.exe (no --launch-product)");
  const negLock = await waitForRcLockfile(90000);
  step("negative-lockfile", { found: !!negLock, describe: describeLock(negLock) });
  if (!negLock) {
    log("  !! no lockfile appeared within 90s — cannot evaluate the negative control");
    step("negative-control", { conclusive: false, note: "client never produced a lockfile" });
  } else {
    log(`  lockfile: ${describeLock(negLock)}`);
    const neg = await waitForAuthenticated(negLock, 40000, 2000);
    step("negative-control", {
      conclusive: true,
      authenticated: neg.ok,
      observations: neg.observations,
    });
    log(`  authenticated after 40s with a wiped session: ${neg.ok} (expected false)`);
    for (const o of neg.observations) {
      log(`    ${o.at}  rso=${o.rso}  loginState=${o.loginState}  identified=${o.identified}`);
    }
    if (neg.ok) {
      log("  !! the client signed in with NO stored session — auth state lives somewhere else too");
      result.negativeControlWarning =
        "Client authenticated with a wiped RiotGamesPrivateSettings.yaml. The session file is " +
        "therefore not the sole auth store; investigate before trusting a file swap to switch accounts.";
    }
  }

  log("\n== stopping again before the restore ==");
  const kill2 = killRiotProcesses();
  step("kill-2", kill2);
  log(`  stopped: ${kill2.alreadyClear ? "(nothing)" : kill2.stopped.join(", ")}`);
  await sleep(2000);
}

// ---------------------------------------------------------------- 5. restore + launch

log("\n== restoring captured session ==");
const restored = restoreSession(capturedFile);
step("restored", { session: restored });
if (restored.sha256 !== before.sha256) {
  log(`  !! restored file hash differs from capture (${restored.sha256.slice(0, 12)} vs ${before.sha256.slice(0, 12)})`);
}
log(`  restored ${restored.bytes} bytes, refresh fp=${restored.refreshToken?.fp}`);

const launch = launchRiotClient();
step("launched", launch);
log(`  launched: ${launch.exe} ${launch.args.join(" ") || "(no args)"}`);

const lock = await waitForRcLockfile(120000);
step("lockfile", { found: !!lock, describe: describeLock(lock) });
if (!lock) fail("Riot Client never wrote a live lockfile within 120s of launch");
log(`  lockfile: ${describeLock(lock)}`);

log("\n== waiting for auto-login ==");
const auth = await waitForAuthenticated(lock, 120000, 2000);
step("auth", auth);
for (const o of auth.observations) {
  log(`  ${o.at}  rso=${o.rso}  loginState=${o.loginState}  identified=${o.identified}`);
}
if (auth.ok) {
  // The Riot Client names the account itself — no need to launch League to learn the Riot ID.
  log(`  signed in as: ${auth.state.riotID ?? "(riotID not reported)"}  country=${auth.state.country ?? "?"}`);
  result.signedInAs = auth.state.riotID ?? null;
  result.localPuuidPresent = Boolean(auth.state.puuid); // value deliberately not recorded
}

// ---------------------------------------------------------------- 6/7. token rotation (EXP-5)

await sleep(4000); // let the client settle and flush any token write
const after = summariseSession();
step("after", { session: after });

result.exp5 = {
  question: "does restoring a session rotate the refresh token?",
  writeCountBefore: before.refreshTokenWriteCount,
  writeCountAfter: after.refreshTokenWriteCount,
  writeCountDelta: after.refreshTokenWriteCount - before.refreshTokenWriteCount,
  refreshTokenChanged: before.refreshToken?.fp !== after.refreshToken?.fp,
  idTokenChanged: before.idToken?.fp !== after.idToken?.fp,
  tdidChanged: before.tdid?.fp !== after.tdid?.fp,
  lastTokenCreationBefore: new Date(before.lastTokenCreationTime).toISOString(),
  lastTokenCreationAfter: new Date(after.lastTokenCreationTime).toISOString(),
  originalTokenCreationStable: before.originalTokenCreationTime === after.originalTokenCreationTime,
};

log("\n== EXP-5 (token rotation, same run) ==");
log(`  write_count      : ${result.exp5.writeCountBefore} -> ${result.exp5.writeCountAfter} (delta ${result.exp5.writeCountDelta})`);
log(`  refresh_token    : ${result.exp5.refreshTokenChanged ? "ROTATED" : "unchanged"}`);
log(`  id_token         : ${result.exp5.idTokenChanged ? "ROTATED" : "unchanged"}`);
log(`  tdid             : ${result.exp5.tdidChanged ? "ROTATED" : "unchanged"}`);
log(`  last_token_creation: ${result.exp5.lastTokenCreationBefore} -> ${result.exp5.lastTokenCreationAfter}`);
log(`  => ${result.exp5.refreshTokenChanged || result.exp5.writeCountDelta > 0
      ? "the session MUST be re-captured after every switch, or the stored copy goes stale"
      : "the stored copy stays valid without a re-capture"}`);

result.processesAtEnd = listRiotProcesses();
result.verdict = auth.ok ? "PASS" : "FAIL";
if (!auth.ok) {
  result.reason = "client did not reach type=='authenticated' within 120s after restoring the session";
}

log(`\n== EXP-1 verdict: ${result.verdict} ==`);
if (!auth.ok) log(`  ${result.reason}`);
log(`  captured session kept at ${capturedFile}`);
log(`recorded -> ${writeResult("exp1-cold-swap", result)}`);
process.exit(auth.ok ? 0 : 1);
