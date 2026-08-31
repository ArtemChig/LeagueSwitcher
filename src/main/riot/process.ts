/**
 * P1.3 — enumerate, terminate and launch Riot processes.
 *
 * Two facts from Phase 0 shape this module:
 *
 *   EXP-6: stopping `RiotClientServices` alone brought down all eight Riot Client processes
 *          within four seconds — the Electron helpers are children. So the default kill is
 *          narrow, with a full sweep as the fallback when something survives.
 *   EXP-7: `RiotClientServices.exe` with NO arguments signs the client in and never starts
 *          League. That is what a switch launches (PLAN §8).
 *
 * Process enumeration is line-oriented rather than ConvertTo-Json on purpose: Windows
 * PowerShell 5.1 serialises a wrapped array as {"value":[...],"Count":n} rather than a bare
 * array. That quirk previously made this return "nothing is running" while the client was up,
 * which silently invalidated an entire experiment.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { riotPaths } from "./paths.js";

const execFileAsync = promisify(execFile);

/** The Riot Client tree. Killing the first normally takes the rest with it. */
export const RIOT_CLIENT_PROCESSES = [
  "RiotClientServices",
  "Riot Client",
  "RiotClientUx",
  "RiotClientUxRender",
  "RiotClientCrashHandler",
] as const;

/** The League client tree — a separate tree, not a child of the Riot Client. */
export const LEAGUE_CLIENT_PROCESSES = [
  "LeagueClient",
  "LeagueClientUx",
  "LeagueClientUxRender",
  "LeagueCrashHandler64",
] as const;

/**
 * A game actually in progress. A switch is REFUSED outright while this runs — not warned
 * about, refused (PLAN §3 S1, §8). Killing it would drop the player out of a live game.
 */
export const GAME_PROCESS = "League of Legends";

export const ALL_RIOT_PROCESSES = [
  ...RIOT_CLIENT_PROCESSES,
  ...LEAGUE_CLIENT_PROCESSES,
  GAME_PROCESS,
] as const;

export interface RiotProcess {
  pid: number;
  name: string;
}

async function powershell(script: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
  );
  return stdout;
}

function psNameArray(names: readonly string[]): string {
  return "@(" + names.map((n) => "'" + n.replace(/'/g, "''") + "'").join(",") + ")";
}

/** Every Riot-related process currently running. */
export async function listRiotProcesses(names: readonly string[] = ALL_RIOT_PROCESSES): Promise<RiotProcess[]> {
  const script =
    `$names = ${psNameArray(names)}; ` +
    "Get-Process -ErrorAction SilentlyContinue | " +
    "Where-Object { $names -contains $_.Name } | " +
    'ForEach-Object { "$($_.Id)|$($_.Name)" }';

  let stdout: string;
  try {
    stdout = await powershell(script);
  } catch {
    return [];
  }

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sep = line.indexOf("|");
      return { pid: Number(line.slice(0, sep)), name: line.slice(sep + 1) };
    })
    .filter((p) => Number.isInteger(p.pid) && p.pid > 0 && p.name.length > 0);
}

/** Is a game in progress? The one condition that makes a switch refuse rather than warn. */
export async function isGameRunning(): Promise<boolean> {
  return (await listRiotProcesses([GAME_PROCESS])).length > 0;
}

/** Is the League client (not a game) up? A switch warns and asks before killing this. */
export async function isLeagueClientRunning(): Promise<boolean> {
  return (await listRiotProcesses(LEAGUE_CLIENT_PROCESSES)).length > 0;
}

export async function isRiotClientRunning(): Promise<boolean> {
  return (await listRiotProcesses(RIOT_CLIENT_PROCESSES)).length > 0;
}

export interface KillReport {
  requested: string[];
  running: RiotProcess[];
  survivors: RiotProcess[];
  escalated: boolean;
  elapsedMs: number;
}

/**
 * Stop processes: ask politely, then insist.
 *
 * `CloseMainWindow` first so the client can flush its own state, then `Stop-Process -Force`
 * on whatever ignored it. Returns survivors rather than throwing — the caller decides whether
 * a survivor is fatal, because for a crash handler it is not.
 */
export async function killProcesses(
  names: readonly string[],
  { graceMs = 3000, settleMs = 800 }: { graceMs?: number; settleMs?: number } = {}
): Promise<KillReport> {
  const started = Date.now();
  const running = await listRiotProcesses(names);
  if (running.length === 0) {
    return { requested: [...names], running: [], survivors: [], escalated: false, elapsedMs: Date.now() - started };
  }

  const list = psNameArray(names);
  const script =
    `$names = ${list}; ` +
    "$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.Name }; " +
    "foreach ($p in $procs) { try { $null = $p.CloseMainWindow() } catch {} } " +
    `Start-Sleep -Milliseconds ${graceMs}; ` +
    "$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.Name }; " +
    "foreach ($p in $procs) { try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch {} } " +
    `Start-Sleep -Milliseconds ${settleMs}`;

  await powershell(script);

  return {
    requested: [...names],
    running,
    survivors: await listRiotProcesses(names),
    escalated: true,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Shut down everything a cold swap needs gone.
 *
 * EXP-6 says killing `RiotClientServices` is normally enough, so that is tried first and the
 * broad sweep only runs if something is left. Saves a few seconds on the common path without
 * assuming the narrow kill always works.
 *
 * Refuses outright if a game is in progress; the caller must check first, and this is the
 * backstop for when it did not.
 */
export async function shutdownRiot(
  { includeLeague = true }: { includeLeague?: boolean } = {}
): Promise<{ reports: KillReport[]; survivors: RiotProcess[]; gameWasRunning: boolean }> {
  if (await isGameRunning()) {
    return { reports: [], survivors: [], gameWasRunning: true };
  }

  const reports: KillReport[] = [];
  const wanted = includeLeague ? [...RIOT_CLIENT_PROCESSES, ...LEAGUE_CLIENT_PROCESSES] : [...RIOT_CLIENT_PROCESSES];

  // Narrow kill first — EXP-6's finding. The grace period is short on purpose:
  // RiotClientServices has no main window, so CloseMainWindow is a no-op on it and waiting
  // 2.5s for a response that cannot come just made every switch 2.5s slower.
  reports.push(await killProcesses(["RiotClientServices"], { graceMs: 600, settleMs: 200 }));

  // Poll for the children rather than sleeping a fixed amount: they exit with the parent
  // (EXP-6) but take a moment, and polling returns the instant they are gone.
  await waitForExit(wanted, { timeoutMs: 8000, intervalMs: 400 });

  let survivors = await listRiotProcesses(wanted);
  if (survivors.length > 0) {
    // Something ignored the parent's exit — fall back to the broad sweep.
    reports.push(await killProcesses(wanted, { graceMs: 2500 }));
    survivors = await listRiotProcesses(wanted);
  }

  return { reports, survivors, gameWasRunning: false };
}

export interface LaunchOptions {
  /**
   * A Riot product to start, e.g. "league_of_legends". Defaults to NOTHING, which is the
   * point: a switch brings up the Riot Client and stops there. The user starts League.
   */
  product?: string | null;
  patchline?: string;
  extraArgs?: string[];
}

export interface LaunchResult {
  exe: string;
  args: string[];
  pid: number | undefined;
}

/** Start the Riot Client, detached, so it outlives this process. */
export function launchRiotClient({ product = null, patchline = "live", extraArgs = [] }: LaunchOptions = {}): LaunchResult {
  const exe = riotPaths.rcServices;
  if (!existsSync(exe)) {
    throw new Error(
      `RiotClientServices.exe not found at ${exe}. ` +
        "Set LEAGUESWITCHER_RIOT_ROOT if Riot is installed somewhere other than C:\\Riot Games."
    );
  }

  const args: string[] = [];
  if (product) args.push(`--launch-product=${product}`, `--launch-patchline=${patchline}`);
  args.push(...extraArgs);

  const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();

  return { exe, args, pid: child.pid };
}

/** Wait for every named process to be gone. Returns false on timeout rather than throwing. */
export async function waitForExit(
  names: readonly string[],
  { timeoutMs = 20_000, intervalMs = 400 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await listRiotProcesses(names)).length === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
