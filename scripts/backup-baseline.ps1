<#
.SYNOPSIS
  P0.1 — Capture a baseline snapshot of the live Riot session/config files.

.DESCRIPTION
  Copies the Riot Client + League session and settings files into
  %APPDATA%\LeagueSwitcher\backups\baseline-<timestamp>\ , records a manifest with
  SHA256 hashes, and emits a restore script next to the backup root.

  Nothing sensitive is written into the repository. The snapshot lives in %APPDATA% only.
  This script is READ-ONLY with respect to the Riot install: it never writes to
  %LOCALAPPDATA%\Riot Games.
#>
[CmdletBinding()]
param(
    [string]$Label = 'baseline'
)

$ErrorActionPreference = 'Stop'

$root       = Join-Path $env:APPDATA 'LeagueSwitcher'
$backupRoot = Join-Path $root 'backups'
$stamp      = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest       = Join-Path $backupRoot "$Label-$stamp"

# Files worth snapshotting. Missing ones are recorded, not fatal.
$targets = @(
    @{ Key = 'riotclient-session';  Path = Join-Path $env:LOCALAPPDATA 'Riot Games\Riot Client\Data\RiotGamesPrivateSettings.yaml' }
    @{ Key = 'riotclient-settings'; Path = Join-Path $env:LOCALAPPDATA 'Riot Games\Riot Client\Config\RiotClientSettings.yaml' }
    @{ Key = 'lol-session';         Path = Join-Path $env:LOCALAPPDATA 'Riot Games\League of Legends\Data\RiotGamesPrivateSettings.yaml' }
    @{ Key = 'lol-settings';        Path = Join-Path $env:LOCALAPPDATA 'Riot Games\League of Legends\Config\RiotClientSettings.yaml' }
    @{ Key = 'riotclient-lockfile'; Path = Join-Path $env:LOCALAPPDATA 'Riot Games\Riot Client\Config\lockfile' }
    @{ Key = 'lcu-lockfile';        Path = 'C:\Riot Games\League of Legends\lockfile' }
)

New-Item -ItemType Directory -Force -Path $dest | Out-Null

$entries = @()
foreach ($t in $targets) {
    $present = Test-Path -LiteralPath $t.Path
    $entry = [ordered]@{
        key     = $t.Key
        source  = $t.Path
        present = $present
    }
    if ($present) {
        $leaf = "$($t.Key)__" + (Split-Path $t.Path -Leaf)
        Copy-Item -LiteralPath $t.Path -Destination (Join-Path $dest $leaf) -Force
        $entry.file   = $leaf
        $entry.bytes  = (Get-Item -LiteralPath $t.Path).Length
        $entry.sha256 = (Get-FileHash -LiteralPath $t.Path -Algorithm SHA256).Hash
        $entry.mtime  = (Get-Item -LiteralPath $t.Path).LastWriteTimeUtc.ToString('o')
        Write-Host ("  captured  {0,-20} {1,6} bytes" -f $t.Key, $entry.bytes)
    } else {
        Write-Host ("  absent    {0,-20} (not running / not present)" -f $t.Key)
    }
    $entries += [pscustomobject]$entry
}

$manifest = [ordered]@{
    label        = $Label
    createdUtc   = (Get-Date).ToUniversalTime().ToString('o')
    machine      = $env:COMPUTERNAME
    riotInstall  = 'C:\Riot Games'
    files        = $entries
}
$manifest | ConvertTo-Json -Depth 5 | Out-File (Join-Path $dest 'manifest.json') -Encoding utf8

# ---- restore script, written at the backup root and pointed at this snapshot ----
$restorePath = Join-Path $backupRoot 'restore-baseline.ps1'
$restoreBody = @'
<#
  Restores a LeagueSwitcher baseline snapshot back over the live Riot files.
  Usage:  powershell -ExecutionPolicy Bypass -File restore-baseline.ps1 [-Snapshot <dir>]
  With no -Snapshot it restores the most recent baseline-* directory.
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
    Write-Warning "Riot/League processes are running. Close them first, then re-run:"
    $running | Select-Object Id, Name | Format-Table -AutoSize | Out-String | Write-Warning
    throw "Refusing to restore while the client is running."
}

foreach ($f in $manifest.files) {
    if (-not $f.present) { continue }
    if ($f.key -match 'lockfile') { continue }   # lockfiles are runtime-only; never restore them
    $src = Join-Path $Snapshot $f.file
    if (-not (Test-Path -LiteralPath $src)) { Write-Warning "missing in snapshot: $($f.file)"; continue }
    $dir = Split-Path -Parent $f.source
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Copy-Item -LiteralPath $src -Destination $f.source -Force
    $now = (Get-FileHash -LiteralPath $f.source -Algorithm SHA256).Hash
    $ok  = if ($now -eq $f.sha256) { 'OK' } else { 'HASH MISMATCH' }
    Write-Host ("  restored  {0,-20} {1}" -f $f.key, $ok)
}

Write-Host "Done. Launch the Riot Client to confirm the original account signs in."
'@
$restoreBody | Out-File $restorePath -Encoding utf8

Write-Host ""
Write-Host "Baseline snapshot: $dest"
Write-Host "Restore with:      powershell -ExecutionPolicy Bypass -File `"$restorePath`""
