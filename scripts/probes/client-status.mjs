/**
 * Status probe — the safe, read-only "what is the machine doing right now" check.
 * Run this before and after every other experiment.
 *
 *   node scripts/probes/client-status.mjs
 *
 * Touches nothing. Prints processes, both lockfiles, the session-file summary and,
 * if the Riot Client is up, the live session/region state from its local API.
 */
import {
  PATHS, describeLock, isGameRunning, listRiotProcesses, localApi, log,
  readLcuLockfile, readRcLockfile, summariseSession, writeResult,
} from "./lib/riotlocal.mjs";
import { existsSync } from "node:fs";

const result = { probe: "client-status" };

log("== processes ==");
const procs = listRiotProcesses();
result.processes = procs;
if (procs.length === 0) log("  none running");
for (const p of procs) log(`  ${p.Name} pid=${p.Id}`);
result.gameRunning = isGameRunning();
if (result.gameRunning) log("  !! League of Legends.exe is RUNNING — switching must be refused");

log("\n== lockfiles ==");
const rc = readRcLockfile();
const lcu = readLcuLockfile();
log(`  riot client : ${describeLock(rc)}`);
log(`  league (lcu): ${describeLock(lcu)}`);
result.rcLockfile = rc ? { present: true, pid: rc.pid, port: rc.port, stale: rc.stale, mtime: rc.mtime } : { present: false };
result.lcuLockfile = lcu ? { present: true, pid: lcu.pid, port: lcu.port, stale: lcu.stale, mtime: lcu.mtime } : { present: false };

log("\n== session file ==");
const session = summariseSession();
result.session = session;
if (!session.present) {
  log("  ABSENT — the client has no stored session");
} else {
  log(`  ${session.bytes} bytes  sha256=${session.sha256.slice(0, 16)}...  mtime=${session.mtime}`);
  log(`  refresh_token       : ${session.refreshToken ? `${session.refreshToken.length} chars fp=${session.refreshToken.fp}` : "ABSENT"}`);
  log(`  id_token            : ${session.idToken ? `${session.idToken.length} chars fp=${session.idToken.fp}` : "ABSENT"}`);
  log(`  tdid                : ${session.tdid ? `${session.tdid.length} chars fp=${session.tdid.fp}` : "ABSENT"}`);
  log(`  write_count         : ${session.refreshTokenWriteCount}`);
  log(`  last_token_creation : ${new Date(session.lastTokenCreationTime).toISOString()}`);
  log(`  is_dpop_bound       : ${session.isDpopBound}  (false = portable, which is what makes this work)`);
  const restoreDays = session.maxDurationBetweenRestores / 86400;
  log(`  max_between_restores: ${session.maxDurationBetweenRestores}s (~${restoreDays.toFixed(0)} days)`);
}

log("\n== install ==");
result.rcServicesPresent = existsSync(PATHS.rcServices);
log(`  RiotClientServices.exe: ${result.rcServicesPresent ? "present" : "MISSING"} (${PATHS.rcServices})`);

if (rc && !rc.stale && !rc.malformed) {
  log("\n== live local API ==");
  result.live = {};
  for (const [label, path] of [
    ["session", "/rso-auth/v1/session"],
    ["region-locale", "/riotclient/region-locale"],
    ["auth-hints", "/rso-auth/v1/auth-hints/hint"],
  ]) {
    try {
      const res = await localApi(rc, "GET", path);
      // The session response carries no token, but be strict anyway: log a shape, not a body.
      const shape = res.json ? Object.fromEntries(Object.entries(res.json).map(([k, v]) => [k, typeof v === "object" && v !== null ? `<${Array.isArray(v) ? "array" : "object"}>` : v])) : res.text.slice(0, 120);
      result.live[label] = { status: res.status, shape };
      log(`  GET ${path} -> ${res.status} ${JSON.stringify(shape)}`);
    } catch (err) {
      result.live[label] = { error: err.message };
      log(`  GET ${path} -> ERROR ${err.message}`);
    }
  }
} else {
  log("\n== live local API ==\n  skipped — no live Riot Client lockfile");
}

const out = writeResult("client-status", result);
log(`\nrecorded -> ${out}`);
