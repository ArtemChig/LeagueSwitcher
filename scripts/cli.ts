/**
 * P1.7 — headless harness for the whole engine.
 *
 *   npm run cli -- status
 *   npm run cli -- list
 *   npm run cli -- capture [--label "Main"]
 *   npm run cli -- switch <id|username|RiotID#TAG> [--yes] [--hot]
 *   npm run cli -- enrol <username>
 *   npm run cli -- health
 *   npm run cli -- vault
 *   npm run cli -- forget <id>
 *   npm run cli -- api-key [<key>|--clear]
 *
 * Every Phase 1 capability is exercisable from here, before a pixel is drawn. That is the
 * point: engine bugs are far cheaper to find in a terminal than through a UI.
 *
 * Nothing printed here goes out unredacted — `say` routes through the redactor.
 */
import { readLockfileState, describeLockfile } from "../src/main/riot/lockfile.js";
import {
  isGameRunning,
  isLeagueClientRunning,
  isRiotClientRunning,
  listRiotProcesses,
} from "../src/main/riot/process.js";
import { readLoginState } from "../src/main/riot/rcApi.js";
import { harvestFromLcu } from "../src/main/riot/lcuApi.js";
import { summariseSession, validateSessionFile } from "../src/main/riot/session.js";
import { appPaths, riotPaths } from "../src/main/riot/paths.js";
import { getAccountStore, type Account } from "../src/main/store/accounts.js";
import { getVault } from "../src/main/store/vault.js";
import { isAvailable as dpapiAvailable } from "../src/main/store/dpapi.js";
import {
  beginAssistedEnrolment,
  captureCurrentSession,
  switchToAccount,
  type SwitchProgress,
} from "../src/main/switch/strategies.js";
import { redact } from "../src/main/log/redact.js";
import { existsSync } from "node:fs";

const say = (...parts: unknown[]) => console.log(parts.map((p) => redact(p)).join(" "));

const [, , command = "help", ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const positional = rest.filter((a) => !a.startsWith("--"));

function flagValue(name: string): string | null {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? (rest[index + 1] ?? null) : null;
}

// ---------------------------------------------------------------- commands

async function cmdStatus(): Promise<number> {
  say("== processes ==");
  const procs = await listRiotProcesses();
  if (procs.length === 0) say("  nothing Riot-related is running");
  for (const p of procs) say(`  ${p.name} (pid ${p.pid})`);

  const gameRunning = await isGameRunning();
  say("");
  say(`  game in progress   : ${gameRunning ? "YES — switching is refused" : "no"}`);
  say(`  League client up   : ${(await isLeagueClientRunning()) ? "yes — a switch will ask before closing it" : "no"}`);
  say(`  Riot Client up     : ${(await isRiotClientRunning()) ? "yes" : "no"}`);

  say("\n== lockfiles ==");
  const rc = readLockfileState("riot-client");
  const lcu = readLockfileState("lcu");
  say(`  riot client : ${describeLockfile(rc)}`);
  say(`  league      : ${describeLockfile(lcu)}`);

  say("\n== session file ==");
  const session = summariseSession();
  if (!session.present) {
    say("  absent — no session stored on this machine");
  } else {
    say(`  ${session.bytes} bytes, sha256 ${session.sha256.slice(0, 16)}…, modified ${session.mtime}`);
    say(`  signed in          : ${session.signedIn ? "yes" : "no"}`);
    say(`  refresh token      : ${session.refreshToken ? `${session.refreshToken.length} chars, fp ${session.refreshToken.fingerprint}` : "absent"}`);
    say(`  write count        : ${session.refreshTokenWriteCount ?? "?"}`);
    say(`  device-bound       : ${session.isDpopBound ? "YES — this token will NOT transfer" : "no (portable)"}`);
    say(`  days until expiry  : ${session.daysUntilExpiry ?? "?"}`);
  }

  if (rc.status === "live") {
    say("\n== signed in as ==");
    const state = await readLoginState(rc.lockfile);
    if (state.authenticated) {
      say(`  ${state.riotId ? `${state.riotId.gameName}#${state.riotId.tagLine}` : "(riot id unavailable)"}`);
      say(`  login username     : ${state.loginUsername ?? "?"}`);
      say(`  platform           : ${state.platformId ?? "?"}`);
      say(`  level              : ${state.summonerLevel ?? "?"}   profile icon: ${state.profileIconId ?? "?"}`);
    } else {
      say(`  not signed in (${state.loginState ?? "starting"})`);
    }
  }

  if (lcu.status === "live") {
    say("\n== league client extras ==");
    const harvest = await harvestFromLcu(lcu.lockfile);
    say(`  level ${harvest.summonerLevel ?? "?"}  BE ${harvest.blueEssence ?? "?"}  RP ${harvest.riotPoints ?? "?"}  honour ${harvest.honorLevel ?? "?"}`);
    if (harvest.soloDuo) {
      const r = harvest.soloDuo;
      say(`  solo/duo: ${r.tier} ${r.division} ${r.leaguePoints} LP  ${r.wins}W ${r.losses}L`);
    }
    if (harvest.unavailable.length) say(`  unavailable: ${harvest.unavailable.length} endpoint(s)`);
  }

  return 0;
}

function renderAccount(a: Account, activeId: string | null): string {
  const riotId = a.gameName ? `${a.gameName}#${a.tagLine}` : "(riot id unknown)";
  const solo = a.ranked.find((r) => r.queue === "RANKED_SOLO_5x5");
  const rank = solo ? `${solo.tier} ${solo.rank} ${solo.leaguePoints} LP` : "Unranked";
  const health = { valid: "ok", stale: "stale", missing: "NEEDS RE-ENROL" }[a.sessionHealth];
  const marker = a.id === activeId ? "*" : " ";
  return [
    `${marker} ${riotId.padEnd(26)} ${a.loginUsername.padEnd(20)}`,
    `${(a.region ?? "?").padEnd(5)} lvl ${String(a.summonerLevel ?? "?").padEnd(4)} ${rank.padEnd(22)} [${health}]`,
  ].join(" ");
}

async function cmdList(): Promise<number> {
  const store = getAccountStore();
  const accounts = store.list();
  const activeId = store.getActiveId();

  if (accounts.length === 0) {
    say("No accounts enrolled yet.");
    say("");
    say("Sign in to the Riot Client, then run:  npm run cli -- capture");
    return 0;
  }

  say(`${accounts.length} account(s)   * = currently signed in\n`);
  for (const a of accounts) say(renderAccount(a, activeId));
  return 0;
}

async function cmdCapture(): Promise<number> {
  const label = flagValue("label");
  say("Capturing the session that is signed in right now…");
  const result = await captureCurrentSession(label ? { label } : {});
  if (!result.ok) {
    say(`FAILED: ${result.error}`);
    return 1;
  }
  const a = result.account!;
  say(`${result.created ? "Enrolled" : "Updated"} ${a.gameName ? `${a.gameName}#${a.tagLine}` : a.loginUsername}`);
  say(`  id              : ${a.id}`);
  say(`  login username  : ${a.loginUsername}`);
  say(`  platform        : ${a.platformId ?? "?"} (${a.region ?? "?"})`);
  say(`  level           : ${a.summonerLevel ?? "?"}`);
  say(`  session expires : in ${a.sessionDaysRemaining ?? "?"} days`);
  return 0;
}

async function cmdSwitch(): Promise<number> {
  const target = positional[0];
  if (!target) {
    say("usage: npm run cli -- switch <id|username|RiotID#TAG> [--yes] [--hot]");
    return 2;
  }

  const store = getAccountStore();
  const account = store.find(target);
  if (!account) {
    say(`No enrolled account matches "${target}".`);
    say("Known accounts:");
    for (const a of store.list()) say(`  ${a.id}  (${a.loginUsername})`);
    return 1;
  }

  say(`Switching to ${account.gameName ? `${account.gameName}#${account.tagLine}` : account.loginUsername}…\n`);

  const started = Date.now();
  const result = await switchToAccount(account.id, {
    confirmedCloseRunningClient: flags.has("--yes"),
    allowHotSwap: flags.has("--hot"),
    onProgress: (p: SwitchProgress) => {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1).padStart(5);
      say(`  ${elapsed}s  ${p.message}${p.detail ? `  (${p.detail})` : ""}`);
    },
  });

  say("");
  if (!result.ok) {
    say(`FAILED: ${result.error}`);
    if (result.needsConfirmation) {
      say("");
      say("Re-run with --yes to close the running client and switch anyway.");
    }
    return 1;
  }

  say(`Switched via ${result.strategy} in ${(result.elapsedMs / 1000).toFixed(1)}s`);
  if (result.loginState?.riotId) {
    say(`Signed in as ${result.loginState.riotId.gameName}#${result.loginState.riotId.tagLine}`);
  }
  if (result.capturedPrevious) say("The previous account's session was saved first.");
  if (result.recaptured) say("The refreshed session was re-captured into the vault.");
  return 0;
}

async function cmdEnrol(): Promise<number> {
  const username = positional[0];
  if (!username) {
    say("usage: npm run cli -- enrol <login username>");
    return 2;
  }

  say(`Assisted enrolment for ${username}.`);
  say("The Riot Client will open at a clean sign-in screen with the username prefilled.");
  say("Sign in there — including the captcha — and the session is captured automatically.");
  say("");

  const result = await beginAssistedEnrolment(username, {
    onProgress: (p) => say(`  ${p.message}`),
  });

  if (!result.ok) {
    say(`\nFAILED: ${result.error}`);
    return 1;
  }
  say(`\nEnrolled ${result.account?.gameName}#${result.account?.tagLine} (${result.accountId})`);
  return 0;
}

async function cmdHealth(): Promise<number> {
  const store = getAccountStore();
  const vault = await getVault();
  const accounts = store.list();

  say("== environment ==");
  say(`  data directory     : ${appPaths.root}`);
  say(`  Riot Client exe    : ${existsSync(riotPaths.rcServices) ? "found" : "MISSING"}`);
  say(`  DPAPI encryption   : ${(await dpapiAvailable()) ? "working" : "NOT WORKING — secrets cannot be stored"}`);
  say(`  API key stored     : ${vault.getApiKey() ? "yes" : "no — rank and match history will be unavailable"}`);
  say(`  baseline backup    : ${existsSync(appPaths.backups) ? "present" : "MISSING — take one before switching"}`);

  if (vault.warnings.length) {
    say("\n== vault warnings ==");
    for (const w of vault.warnings) say(`  [${w.kind}] ${w.message}${w.detail ? `\n      ${w.detail}` : ""}`);
  }

  say("\n== live session ==");
  const validation = validateSessionFile(riotPaths.session);
  say(`  ${validation.valid ? "usable" : "NOT usable"}`);
  for (const reason of validation.reasons) say(`    - ${reason}`);

  say("\n== enrolled accounts ==");
  if (accounts.length === 0) say("  none");
  for (const a of accounts) {
    const stored = vault.hasSession(a.id);
    const cred = vault.hasCredential(a.id);
    say(`  ${a.id.padEnd(22)} session:${stored ? "yes" : "NO "}  password:${cred ? "yes" : "no "}  health:${a.sessionHealth}  expires:${a.sessionDaysRemaining ?? "?"}d`);
    if (a.lastError) say(`      last error: ${a.lastError}`);
  }

  const orphanSessions = vault.listSessionAccountIds().filter((id) => !store.get(id));
  if (orphanSessions.length) {
    say("\n== stored sessions with no profile ==");
    for (const id of orphanSessions) say(`  ${id}`);
  }

  return 0;
}

async function cmdVault(): Promise<number> {
  const vault = await getVault();
  say("== vault ==");
  say(`  location        : ${appPaths.secrets}`);
  say(`  API key         : ${vault.getApiKey() ? "stored (never displayed)" : "not set"}`);
  say(`  credentials for : ${vault.listCredentialAccountIds().join(", ") || "(none)"}`);
  say(`  sessions for    : ${vault.listSessionAccountIds().join(", ") || "(none)"}`);
  for (const w of vault.warnings) say(`  [${w.kind}] ${w.message}`);
  return 0;
}

async function cmdApiKey(): Promise<number> {
  const vault = await getVault();
  if (flags.has("--clear")) {
    await vault.setApiKey(null);
    say("API key cleared.");
    return 0;
  }
  const key = positional[0];
  if (!key) {
    say(vault.getApiKey() ? "An API key is stored. It is never displayed." : "No API key stored.");
    say("usage: npm run cli -- api-key <RGAPI-…>   |   npm run cli -- api-key --clear");
    return 0;
  }
  await vault.setApiKey(key);
  say("API key stored, encrypted.");
  return 0;
}

async function cmdForget(): Promise<number> {
  const target = positional[0];
  if (!target) {
    say("usage: npm run cli -- forget <id>");
    return 2;
  }
  const store = getAccountStore();
  const account = store.find(target);
  if (!account) {
    say(`No account matches "${target}".`);
    return 1;
  }
  if (!flags.has("--yes")) {
    say(`This deletes ${account.loginUsername}'s stored session and password.`);
    say("Re-run with --yes to confirm.");
    return 1;
  }
  const vault = await getVault();
  await vault.forget(account.id);
  store.remove(account.id);
  say(`Removed ${account.id}.`);
  return 0;
}

function cmdHelp(): number {
  say("LeagueSwitcher engine CLI\n");
  say("  status                 what is running, which session is on disk, who is signed in");
  say("  list                   enrolled accounts");
  say("  capture [--label X]    save the currently signed-in session as an account");
  say("  switch <who> [--yes]   switch to an enrolled account (--yes closes a running client)");
  say("  enrol <username>       assisted sign-in, then capture");
  say("  health                 environment, vault and per-account diagnostics");
  say("  vault                  what the vault holds (never its contents)");
  say("  api-key [<key>]        store or clear the Riot API key");
  say("  forget <who> --yes     delete an account's session and password");
  return 0;
}

// ---------------------------------------------------------------- dispatch

const commands: Record<string, () => Promise<number> | number> = {
  status: cmdStatus,
  list: cmdList,
  capture: cmdCapture,
  switch: cmdSwitch,
  enrol: cmdEnrol,
  enroll: cmdEnrol,
  health: cmdHealth,
  vault: cmdVault,
  "api-key": cmdApiKey,
  forget: cmdForget,
  help: cmdHelp,
};

const handler = commands[command];
if (!handler) {
  say(`unknown command "${command}"\n`);
  cmdHelp();
  process.exit(2);
}

try {
  process.exit(await handler());
} catch (err) {
  say(`\nunexpected failure: ${(err as Error).message}`);
  if (process.env.LEAGUESWITCHER_DEBUG) console.error(err);
  process.exit(1);
}
