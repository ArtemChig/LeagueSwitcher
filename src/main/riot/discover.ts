/**
 * Find where Riot is actually installed on this machine.
 *
 * The app used to assume `C:\Riot Games`, overridable only by setting an environment variable.
 * That is fine on the machine it was written on and useless to anyone who put Riot on another
 * drive — which is common, because the League install is large. Telling a stranger to set
 * LEAGUESWITCHER_RIOT_ROOT before the app will start is not an install experience.
 *
 * Riot already records this. `%PROGRAMDATA%\Riot Games\RiotClientInstalls.json` is written by
 * the installer and maps every product to the RiotClientServices.exe that launches it:
 *
 *   {
 *     "associated_client": { "D:/Riot Games/League of Legends/": "D:/Riot Games/Riot Client/RiotClientServices.exe" },
 *     "rc_default": "D:/Riot Games/Riot Client/RiotClientServices.exe",
 *     "rc_live":    "D:/Riot Games/Riot Client/RiotClientServices.exe"
 *   }
 *
 * Note the forward slashes — Riot writes them that way, so every path read from this file has to
 * be normalised before it is joined or compared.
 *
 * Order of preference: an explicit override, then Riot's own manifest, then the per-product
 * metadata, then the default. Every step is verified against the filesystem, so a stale manifest
 * entry for an uninstalled drive falls through instead of breaking the app.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";

export interface RiotInstall {
  /** Full path to RiotClientServices.exe — the thing a switch launches. */
  rcServices: string;
  /** The "League of Legends" directory, which holds the LCU lockfile. */
  leagueDir: string;
  /** How this was found, for diagnostics and for the settings screen. */
  source: "override" | "installs-manifest" | "product-metadata" | "default";
}

const DEFAULT_ROOT = "C:\\Riot Games";

function programData(): string {
  return process.env.PROGRAMDATA ?? "C:\\ProgramData";
}

/** Riot writes forward slashes; Windows APIs want backslashes. */
function win(p: string): string {
  return normalize(p.replace(/\//g, "\\"));
}

function fromRoot(root: string, source: RiotInstall["source"]): RiotInstall {
  return {
    rcServices: join(root, "Riot Client", "RiotClientServices.exe"),
    leagueDir: join(root, "League of Legends"),
    source,
  };
}

/** `<root>/Riot Client/RiotClientServices.exe` → `<root>` */
function rootFromServicesPath(exe: string): string {
  return resolve(dirname(dirname(win(exe))));
}

function readInstallsManifest(): RiotInstall | null {
  const manifest = join(programData(), "Riot Games", "RiotClientInstalls.json");
  if (!existsSync(manifest)) return null;

  let parsed: {
    rc_live?: string;
    rc_default?: string;
    associated_client?: Record<string, string>;
  };
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    return null;
  }

  // The League directory is the key in associated_client, which is authoritative even when the
  // game and the client live on different drives.
  const associations = Object.entries(parsed.associated_client ?? {});
  for (const [gameDir, exe] of associations) {
    const league = win(gameDir).replace(/[\\/]+$/, "");
    const services = win(exe);
    if (existsSync(services) && /league of legends/i.test(league)) {
      return { rcServices: services, leagueDir: league, source: "installs-manifest" };
    }
  }

  for (const candidate of [parsed.rc_live, parsed.rc_default]) {
    if (!candidate) continue;
    const services = win(candidate);
    if (existsSync(services)) {
      return { ...fromRoot(rootFromServicesPath(services), "installs-manifest"), rcServices: services };
    }
  }

  return null;
}

function readProductMetadata(): RiotInstall | null {
  const yaml = join(
    programData(),
    "Riot Games",
    "Metadata",
    "league_of_legends.live",
    "league_of_legends.live.product_settings.yaml"
  );
  if (!existsSync(yaml)) return null;

  try {
    const text = readFileSync(yaml, "utf8");
    const full = text.match(/^\s*product_install_full_path:\s*"?([^"\r\n]+)"?/m)?.[1];
    const root = text.match(/^\s*product_install_root:\s*"?([^"\r\n]+)"?/m)?.[1];
    if (full) {
      const leagueDir = win(full).replace(/[\\/]+$/, "");
      const base = root ? win(root).replace(/[\\/]+$/, "") : dirname(leagueDir);
      const rcServices = join(base, "Riot Client", "RiotClientServices.exe");
      if (existsSync(rcServices)) return { rcServices, leagueDir, source: "product-metadata" };
    }
  } catch {
    /* fall through */
  }
  return null;
}

let cached: RiotInstall | null = null;

/**
 * Resolve the install once per process.
 *
 * Cached because it touches the disk and is read on every path lookup; Riot does not move
 * while the app is running, and `resetRiotInstallCache()` exists for tests.
 */
export function discoverRiotInstall(): RiotInstall {
  if (cached) return cached;

  const override = process.env.LEAGUESWITCHER_RIOT_ROOT;
  if (override) {
    cached = fromRoot(win(override), "override");
    return cached;
  }

  cached = readInstallsManifest() ?? readProductMetadata() ?? fromRoot(DEFAULT_ROOT, "default");
  return cached;
}

export function resetRiotInstallCache(): void {
  cached = null;
}
