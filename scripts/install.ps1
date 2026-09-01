<#
    Install LeagueSwitcher for the current user.

        powershell -ExecutionPolicy Bypass -File scripts\install.ps1

    Copies the portable exe somewhere permanent and adds a Start-menu entry, so typing
    "leagueswitcher" and pressing Enter launches it.

    Why a copy: `release\` is rebuilt (and wiped) every time `npm run dist` runs, so a shortcut
    pointing there breaks on the next build. The installed copy is independent.

    Nothing is written outside the current user's profile, no admin rights are needed, and
    -Uninstall reverses all of it.
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$NoDesktop
)

$ErrorActionPreference = 'Stop'

$appName   = 'LeagueSwitcher'
$installTo = Join-Path $env:LOCALAPPDATA "Programs\$appName"
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$lnk       = Join-Path $startMenu "$appName.lnk"
$desktop   = Join-Path ([Environment]::GetFolderPath('Desktop')) "$appName.lnk"

if ($Uninstall) {
    foreach ($p in @($lnk, $desktop)) {
        if (Test-Path $p) { Remove-Item $p -Force; Write-Host "removed  $p" -ForegroundColor DarkGray }
    }
    if (Test-Path $installTo) {
        Remove-Item $installTo -Recurse -Force
        Write-Host "removed  $installTo" -ForegroundColor DarkGray
    }
    Write-Host ""
    Write-Host "Uninstalled. Your accounts and vault in %APPDATA%\$appName are untouched." -ForegroundColor Green
    Write-Host "Delete that folder by hand if you also want the saved sessions gone."
    return
}

$repo = Split-Path -Parent $PSScriptRoot
$source = Get-ChildItem (Join-Path $repo 'release') -Filter '*portable*.exe' -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $source) {
    throw "No portable exe found in $repo\release. Run 'npm run dist' first."
}

Write-Host ""
Write-Host "Installing $appName" -ForegroundColor Cyan
Write-Host "  from  $($source.FullName)"
Write-Host "  built $($source.LastWriteTime)"
Write-Host ""

New-Item -ItemType Directory -Force -Path $installTo | Out-Null
$target = Join-Path $installTo "$appName.exe"

# Refuse to overwrite a copy that is currently running — the copy would fail halfway.
$running = Get-Process -Name $appName -ErrorAction SilentlyContinue
if ($running) {
    throw "$appName is running. Close it and re-run this script."
}

Copy-Item $source.FullName $target -Force
Write-Host "installed  $target" -ForegroundColor Green

$shell = New-Object -ComObject WScript.Shell

$s = $shell.CreateShortcut($lnk)
$s.TargetPath       = $target
$s.WorkingDirectory = $installTo
$s.IconLocation     = "$target,0"
$s.Description      = 'Switch between League of Legends accounts'
$s.Save()
Write-Host "start menu $lnk" -ForegroundColor Green

if (-not $NoDesktop) {
    $d = $shell.CreateShortcut($desktop)
    $d.TargetPath       = $target
    $d.WorkingDirectory = $installTo
    $d.IconLocation     = "$target,0"
    $d.Description      = 'Switch between League of Legends accounts'
    $d.Save()
    Write-Host "desktop    $desktop" -ForegroundColor Green
}

Write-Host ""
Write-Host "Done. Press Start, type 'leagueswitcher', hit Enter." -ForegroundColor Green
Write-Host "Search can take a minute to index the new entry the first time."
Write-Host ""
Write-Host "To undo:  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall" -ForegroundColor DarkGray
