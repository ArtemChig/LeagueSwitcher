/**
 * P5.3 — the safety net, in TypeScript so the packaged app can take one.
 *
 * `scripts/backup-baseline.ps1` does the same job for the repo, but scripts/ is not shipped
 * inside the exe, and the first thing a first run must do is take a backup. PLAN §7 rule 1:
 * "Phase 0.1 backup before anything else. No exceptions."
 *
 * What a baseline is for: this app rewrites the file the Riot Client authenticates from. If
 * something goes wrong, the honest recovery is "put back exactly what was there before we
 * touched anything" — which only exists if it was copied first. The snapshot is never deleted
 * or rotated automatically for the same reason.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { appPaths, riotPaths } from "../riot/paths.js";

export interface BackupFileEntry {
  key: string;
  source: string;
  present: boolean;
  file?: string;
  bytes?: number;
  sha256?: string;
}

export interface BackupManifest {
  label: string;
  createdUtc: string;
  files: BackupFileEntry[];
}

export interface BackupResult {
  ok: boolean;
  directory: string;
  captured: number;
  manifest?: BackupManifest;
  error?: string;
}

/** What is worth snapshotting. Lockfiles are runtime-only and deliberately excluded. */
function targets(): Array<{ key: string; path: string }> {
  return [
    { key: "riotclient-session", path: riotPaths.session },
    { key: "riotclient-settings", path: riotPaths.clientSettings },
  ];
}

export function listBaselines(): string[] {
  if (!existsSync(appPaths.backups)) return [];
  return readdirSync(appPaths.backups)
    .filter((d) => d.startsWith("baseline-"))
    .sort();
}

export function hasBaseline(): boolean {
  return listBaselines().length > 0;
}

/** Take a snapshot. Read-only with respect to the Riot install — it only ever copies out. */
export function createBaselineBackup(label = "baseline"): BackupResult {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");
  const directory = join(appPaths.backups, `${label}-${stamp}`);

  try {
    mkdirSync(directory, { recursive: true });

    const files: BackupFileEntry[] = [];
    let captured = 0;

    for (const target of targets()) {
      const present = existsSync(target.path);
      const entry: BackupFileEntry = { key: target.key, source: target.path, present };

      if (present) {
        const leaf = `${target.key}__${target.path.split("\\").pop() ?? "file"}`;
        copyFileSync(target.path, join(directory, leaf));
        const contents = readFileSync(target.path);
        entry.file = leaf;
        entry.bytes = statSync(target.path).size;
        entry.sha256 = createHash("sha256").update(contents).digest("hex");
        captured++;
      }
      files.push(entry);
    }

    const manifest: BackupManifest = { label, createdUtc: new Date().toISOString(), files };
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    // The recovery path has to work when the app itself will not start, so a snapshot ships
    // with a plain PowerShell restorer beside it that depends on nothing but Windows.
    writeRestoreScript();

    return { ok: true, directory, captured, manifest };
  } catch (err) {
    return { ok: false, directory, captured: 0, error: (err as Error).message };
  }
}

/**
 * Write `restore-baseline.ps1` at the backups root.
 *
 * Deliberately dependency-free PowerShell: if this app is broken enough to need a restore, it
 * is not the thing to rely on for performing one. It refuses to run while the client is up,
 * and verifies each restored file against the manifest's hash.
 */
function writeRestoreScript(): void {
  const script = `<#
  Restores a LeagueSwitcher baseline snapshot over the live Riot session file.

    powershell -ExecutionPolicy Bypass -File restore-baseline.ps1 [-Snapshot <dir>]

  With no -Snapshot it restores the most recent baseline-* directory.
  Written automatically by LeagueSwitcher; safe to run by hand.
#>
[CmdletBinding()]
param([string]$Snapshot)

$ErrorActionPreference = 'Stop'
$backupRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $Snapshot) {
    $Snapshot = (Get-ChildItem $backupRoot -Directory -Filter 'baseline-*' |
                 Sort-Object Name -Descending | Select-Object -First 1).FullName
}
if (-not $Snapshot -or -not (Test-Path -LiteralPath $Snapshot)) {
    throw "No baseline snapshot found under $backupRoot"
}

$manifest = Get-Content (Join-Path $Snapshot 'manifest.json') -Raw | ConvertFrom-Json
Write-Host "Restoring snapshot: $Snapshot  (created $($manifest.createdUtc))"

$running = Get-Process -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -match '^(RiotClient|Riot Client|LeagueClient)' }
if ($running) {
    $running | Select-Object Id, Name | Format-Table -AutoSize | Out-String | Write-Warning
    throw "Close the Riot and League clients first, then re-run."
}

foreach ($f in $manifest.files) {
    if (-not $f.present) { continue }
    $src = Join-Path $Snapshot $f.file
    if (-not (Test-Path -LiteralPath $src)) { Write-Warning "missing in snapshot: $($f.file)"; continue }
    $dir = Split-Path -Parent $f.source
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Copy-Item -LiteralPath $src -Destination $f.source -Force
    $now = (Get-FileHash -LiteralPath $f.source -Algorithm SHA256).Hash
    $ok  = if ($now -eq $f.sha256) { 'OK' } else { 'HASH MISMATCH' }
    Write-Host ("  restored  {0,-22} {1}" -f $f.key, $ok)
}

Write-Host "Done. Start the Riot Client to confirm the original account signs in."
`;
  writeFileSync(join(appPaths.backups, "restore-baseline.ps1"), script, "utf8");
}

/** The newest snapshot's session file, for panic restore. */
export function latestBaselineSessionFile(): string | null {
  const latest = listBaselines().at(-1);
  if (!latest) return null;

  const dir = join(appPaths.backups, latest);
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as BackupManifest;
    const entry = manifest.files.find((f) => f.key === "riotclient-session" && f.present && f.file);
    if (entry?.file) {
      const path = join(dir, entry.file);
      return existsSync(path) ? path : null;
    }
  } catch {
    /* fall through to the conventional name */
  }

  const fallback = join(dir, "riotclient-session__RiotGamesPrivateSettings.yaml");
  return existsSync(fallback) ? fallback : null;
}
