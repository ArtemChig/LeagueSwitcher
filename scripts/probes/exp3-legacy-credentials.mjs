/**
 * EXP-3 (reachability only) — is the legacy password endpoint still implemented?
 *
 *   node scripts/probes/exp3-legacy-credentials.mjs
 *
 * PLAN §3 S3b hopes `PUT /rso-auth/v1/session/credentials` still works, because its schema has
 * no captcha field, which would make headless enrolment possible. Full EXP-3 needs a real
 * credential and this machine has none (`test-credentials.json` is gone) — so P0.6 stays BLOCKED.
 *
 * But the FIRST question does not need a credential at all: is the route even registered at
 * runtime? EXP-2 established that this client ships a 789-path spec containing routes that
 * answer 404 RPC_ERROR "Not Found" — the spec is a superset of what is implemented. If this
 * endpoint is one of those, the S3b path is dead regardless of what credentials arrive in the
 * morning, and that is worth knowing tonight.
 *
 * SAFETY, by construction, not by care:
 *   - This script accepts NO credential arguments. There is no code path that can send a real
 *     username or password, so it cannot consume any account's 2-attempt budget (hard rule 9).
 *   - It sends EXACTLY ONE request and never retries, whatever comes back (hard rule 10).
 */
import { describeLock, localApi, log, readRcLockfile, writeResult } from "./lib/riotlocal.mjs";

if (process.argv.length > 2) {
  log("This probe takes no arguments. It deliberately cannot be given credentials.");
  process.exit(2);
}

const lock = readRcLockfile();
if (!lock || lock.stale || lock.malformed) {
  log(`Riot Client lockfile: ${describeLock(lock)} — start the client first`);
  process.exit(2);
}
log(`Riot Client: ${describeLock(lock)}`);

const result = { probe: "exp3-legacy-credentials", scope: "reachability only — no credential sent" };

// Empty strings: no account is named, so nothing can be locked out or rate-limited per-account.
const body = { username: "", password: "", region: "", persistLogin: false };

log("\n== PUT /rso-auth/v1/session/credentials (empty credentials, one attempt, no retry) ==");
let res;
try {
  res = await localApi(lock, "PUT", "/rso-auth/v1/session/credentials", body);
} catch (err) {
  result.verdict = "ERROR";
  result.error = err.message;
  log(`  transport error: ${err.message}`);
  log(`\nrecorded -> ${writeResult("exp3-legacy-credentials", result)}`);
  process.exit(1);
}

result.status = res.status;
result.type = res.json?.type ?? null;
result.errorCode = res.json?.errorCode ?? null;
result.message = res.json?.message ?? null;
result.error = res.json?.error ?? null;
result.retryAfter = res.json?.retryAfter ?? null;

log(`  -> ${res.status}`);
if (res.json) {
  for (const [k, v] of Object.entries(res.json)) {
    if (v === null || v === "" || (typeof v === "object" && Object.keys(v).length === 0)) continue;
    log(`     ${k}: ${typeof v === "object" ? JSON.stringify(v).slice(0, 160) : v}`);
  }
} else {
  log(`     body: ${res.text.slice(0, 300)}`);
}

// A 404 with RPC_ERROR/"Not Found" is the same signature EXP-2 saw: declared in the spec,
// absent at runtime. Anything else means the route lives and only the credential is missing.
const notImplemented = res.status === 404 && /not found/i.test(res.json?.message ?? "");

if (notImplemented) {
  result.verdict = "ROUTE ABSENT";
  result.conclusion =
    "The legacy credentials endpoint is declared in the spec but answers 404 RPC_ERROR 'Not Found' " +
    "at runtime, exactly like the refresh-token route in EXP-2. S3b cannot work on this client " +
    "build, with or without a credential. Enrolment must go through S4 assisted login.";
  log(`\n== EXP-3 (reachability): ROUTE ABSENT ==`);
} else {
  result.verdict = "ROUTE PRESENT";
  result.conclusion =
    "The route is implemented — it answered rather than 404ing. Whether it bypasses hCaptcha is " +
    "still unknown and needs one real credential to settle. Retest in the morning under hard rule 9.";
  log(`\n== EXP-3 (reachability): ROUTE PRESENT — worth a real test once credentials exist ==`);
}
log(`  ${result.conclusion}`);
log(`\nrecorded -> ${writeResult("exp3-legacy-credentials", result)}`);
