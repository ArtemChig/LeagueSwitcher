/**
 * P2.5 — on-disk asset cache.
 *
 * Profile icons and rank crests are downloaded once into %APPDATA%\LeagueSwitcher\cache\ so
 * the grid renders instantly and keeps working offline (PLAN §4.6).
 *
 * Crests are additionally BUNDLED with the app (`assets/crests/`, produced by
 * scripts/fetch-crests.mjs). There are only eleven and they almost never change, so the bundle
 * is the fallback that makes first run and offline use look finished rather than broken. The
 * bundled diamond crest already carries the colour correction — see that script for why.
 *
 * The Data Dragon version is pinned rather than resolved per request: mixing versions across a
 * session means icons change appearance mid-refresh for no visible reason.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appPaths } from "../riot/paths.js";

const DDRAGON_VERSIONS = "https://ddragon.leagueoflegends.com/api/versions.json";
const CREST_BASE =
  "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-mini-crests";

/** Fallback if the version list cannot be reached on first run. Verified live 2026-08-31. */
export const FALLBACK_DDRAGON_VERSION = "16.17.1";

export const TIERS = [
  "iron", "bronze", "silver", "gold", "platinum", "emerald",
  "diamond", "master", "grandmaster", "challenger", "unranked",
] as const;

export type Tier = (typeof TIERS)[number];

interface CacheMeta {
  ddragonVersion: string;
  versionCheckedAt: string;
}

function cacheDir(...parts: string[]): string {
  const dir = join(appPaths.cache, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function metaPath(): string {
  return join(appPaths.cache, "meta.json");
}

function readMeta(): CacheMeta | null {
  try {
    return JSON.parse(readFileSync(metaPath(), "utf8")) as CacheMeta;
  } catch {
    return null;
  }
}

function writeMeta(meta: CacheMeta): void {
  mkdirSync(appPaths.cache, { recursive: true });
  writeFileSync(metaPath(), JSON.stringify(meta, null, 2), "utf8");
}

function atomicWrite(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${process.pid}-${Date.now()}.tmp`);
  writeFileSync(temp, data);
  renameSync(temp, path);
}

/** Where the bundled crests live, relative to this file at runtime. */
function bundledCrestPath(tier: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "assets", "crests", `${tier}.svg`);
}

/**
 * The pinned Data Dragon version.
 *
 * Re-checked at most once a day: patches ship every couple of weeks, so hammering the version
 * endpoint on every launch is pure noise. A failed check keeps the cached value rather than
 * falling back, because a stale-but-real version renders correctly and a fallback may not.
 */
export async function getDataDragonVersion({ force = false }: { force?: boolean } = {}): Promise<string> {
  const meta = readMeta();
  const dayMs = 86_400_000;

  if (!force && meta?.ddragonVersion) {
    const age = Date.now() - new Date(meta.versionCheckedAt).getTime();
    if (age < dayMs) return meta.ddragonVersion;
  }

  try {
    const res = await fetch(DDRAGON_VERSIONS, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const versions = (await res.json()) as string[];
      const latest = versions[0];
      if (latest) {
        writeMeta({ ddragonVersion: latest, versionCheckedAt: new Date().toISOString() });
        return latest;
      }
    }
  } catch {
    /* offline — fall through to whatever we already know */
  }

  return meta?.ddragonVersion ?? FALLBACK_DDRAGON_VERSION;
}

export interface CachedAsset {
  path: string;
  /** How this was obtained, so the UI can distinguish "offline placeholder" from "real". */
  source: "cache" | "downloaded" | "bundled" | "missing";
}

/** A profile icon, downloaded once. */
export async function getProfileIcon(iconId: number, version?: string): Promise<CachedAsset> {
  const ver = version ?? (await getDataDragonVersion());
  const dir = cacheDir("icons", ver);
  const path = join(dir, `${iconId}.png`);

  if (existsSync(path) && statSync(path).size > 0) return { path, source: "cache" };

  try {
    const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ver}/img/profileicon/${iconId}.png`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      atomicWrite(path, Buffer.from(await res.arrayBuffer()));
      return { path, source: "downloaded" };
    }
  } catch {
    /* offline */
  }

  return { path, source: "missing" };
}

/**
 * A rank crest. Cache, then network, then the bundled copy — so this only fails if the app
 * itself is missing files.
 */
export async function getRankCrest(tier: string): Promise<CachedAsset> {
  const normalised = (TIERS as readonly string[]).includes(tier.toLowerCase())
    ? tier.toLowerCase()
    : "unranked";

  const path = join(cacheDir("crests"), `${normalised}.svg`);
  if (existsSync(path) && statSync(path).size > 0) return { path, source: "cache" };

  try {
    const res = await fetch(`${CREST_BASE}/${normalised}.svg`, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      let svg = await res.text();
      // Same correction the bundler applies. Community Dragon's diamond crest is tinted a
      // purple almost identical to Master's, which makes the two tiers indistinguishable.
      if (normalised === "diamond") svg = svg.replace(/#8141EB/gi, "#4C6FD9");
      atomicWrite(path, svg);
      return { path, source: "downloaded" };
    }
  } catch {
    /* offline */
  }

  const bundled = bundledCrestPath(normalised);
  if (existsSync(bundled)) return { path: bundled, source: "bundled" };

  return { path, source: "missing" };
}

/** Read a crest's SVG markup for inlining into the renderer. */
export async function readCrestSvg(tier: string): Promise<string | null> {
  const asset = await getRankCrest(tier);
  if (asset.source === "missing") return null;
  try {
    return readFileSync(asset.path, "utf8");
  } catch {
    return null;
  }
}

/** Warm the cache for the tiers and icons currently on screen. Failures are not fatal. */
export async function warmCache(iconIds: number[], tiers: string[]): Promise<{ icons: number; crests: number }> {
  const version = await getDataDragonVersion();

  const iconResults = await Promise.all([...new Set(iconIds)].map((id) => getProfileIcon(id, version).catch(() => null)));
  const crestResults = await Promise.all([...new Set(tiers)].map((t) => getRankCrest(t).catch(() => null)));

  return {
    icons: iconResults.filter((r) => r && r.source !== "missing").length,
    crests: crestResults.filter((r) => r && r.source !== "missing").length,
  };
}
