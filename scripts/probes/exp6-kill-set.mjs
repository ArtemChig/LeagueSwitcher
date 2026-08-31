/**
 * EXP-6 — what is the minimum set of processes a cold swap has to stop?
 *
 *   node scripts/probes/exp6-kill-set.mjs
 *
 * Switch speed is dominated by how much gets torn down and restarted, so it is worth knowing
 * whether the seven-odd Electron helpers have to be killed individually or whether they are
 * children that fall over when RiotClientServices.exe goes.
 *
 * Method: with the client up, stop ONLY RiotClientServices, wait, and see what is left. Then
 * report which names survived and needed the full sweep. Ends by restoring a signed-in client.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PATHS, captureSession, isGameRunning, killRiotProcesses, launchRiotClient, listRiotProcesses,
  log, restoreSession, sleep, summariseSession, waitForAuthenticated, waitForRcLockfile, writeResult,
} from "./lib/riotlocal.mjs";
import { mkdirSync } from "node:fs";

const result = { probe: "exp6-kill-set", steps: [] };
const step = (name, data) => { result.steps.push({ name, at: new Date().toISOString(), ...data }); return data; };
const names = (list) => [...new Set(list.map((p) => p.Name))].sort();

if (isGameRunning()) { log("League of Legends.exe is running — refusing"); process.exit(1); }

const backups = existsSync(PATHS.backups) ? readdirSync(PATHS.backups).filter((d) => d.startsWith("baseline-")) : [];
if (backups.length === 0) { log("no baseline snapshot — hard rule 1 forbids proceeding"); process.exit(1); }

const before = summariseSession();
if (!before.present || !before.hasAuthorization) { log("no live session to work with"); process.exit(1); }

const captureDir = join(PATHS.appRoot, "probe-sessions");
mkdirSync(captureDir, { recursive: true });
const capturedFile = join(captureDir, `exp6-capture-${Date.now()}.yaml`);
captureSession(capturedFile);
log(`captured session -> ${capturedFile}`);

// ---------------------------------------------------------------- ensure a client is up

let lock = await waitForRcLockfile(8000);
if (!lock) {
  log("\nno client running — launching one");
  launchRiotClient();
  lock = await waitForRcLockfile(120000);
  if (!lock) { log("client never came up"); process.exit(1); }
  await waitForAuthenticated(lock, 120000, 2000);
}

const running = listRiotProcesses();
step("running-before", { processes: running.map((p) => `${p.Name}#${p.Id}`), distinctNames: names(running) });
log(`\n== running before ==\n  ${names(running).join(", ")}  (${running.length} processes)`);

// ---------------------------------------------------------------- stop only the parent

log("\n== stopping ONLY RiotClientServices ==");
const t0 = Date.now();
killRiotProcesses({ only: ["RiotClientServices"], graceMs: 3000 });
await sleep(4000);

const after = listRiotProcesses();
const survivors = names(after);
step("after-parent-kill", {
  elapsedMs: Date.now() - t0,
  processes: after.map((p) => `${p.Name}#${p.Id}`),
  survivingNames: survivors,
});
log(`  survivors after 4s: ${survivors.length ? survivors.join(", ") + ` (${after.length} processes)` : "none — everything exited with the parent"}`);

result.childrenDieWithParent = after.filter((p) => p.Name !== "RiotClientCrashHandler").length === 0;
result.survivingNames = survivors;
result.minimumKillSet = result.childrenDieWithParent
  ? ["RiotClientServices"]
  : ["RiotClientServices", ...survivors.filter((n) => n !== "RiotClientCrashHandler")];

log(`\n  => minimum kill set: ${result.minimumKillSet.join(", ")}`);
if (!result.childrenDieWithParent) {
  log("     (the helpers do NOT exit on their own — the app must sweep them explicitly)");
}

// ---------------------------------------------------------------- full sweep + restore

log("\n== full sweep and restore ==");
const sweep = killRiotProcesses();
step("full-sweep", sweep);
await sleep(2000);
restoreSession(capturedFile);
launchRiotClient();
const back = await waitForRcLockfile(120000);
const auth = back ? await waitForAuthenticated(back, 120000, 2000) : { ok: false };
result.leftSignedIn = auth.ok;
log(`  client back up and ${auth.ok ? "signed in" : "NOT signed in — check by hand"}`);

result.verdict = "DONE";
log(`\nrecorded -> ${writeResult("exp6-kill-set", result)}`);
