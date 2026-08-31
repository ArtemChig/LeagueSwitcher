/**
 * P3.1 / P3.7 — the Electron main process.
 *
 * Everything privileged lives here: filesystem, process control, the vault, the local APIs.
 * The renderer gets typed IPC and nothing else (see src/shared/ipc.ts for why).
 *
 * P3.7's single-instance lock is not cosmetic. Two copies of this app could each capture and
 * restore the session file at the same time, and the interleaving that produces is exactly how
 * an account's session gets lost. The second instance focuses the first and exits.
 */
import { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { appPaths, riotPaths } from "./riot/paths.js";
import { readLockfile } from "./riot/lockfile.js";
import { getRunningState, isGameRunning } from "./riot/process.js";
import { readLoginState } from "./riot/rcApi.js";
import { restoreSessionFromString } from "./riot/session.js";
import { getAccountStore, regionFromPlatform, type Account } from "./store/accounts.js";
import { getVault } from "./store/vault.js";
import { refreshAllAccounts } from "./api/refreshAll.js";
import { adoptOrphanSessions } from "./store/adopt.js";
import { buildExternalLinks } from "./api/links.js";
import { collectForCurrentAccount, refreshSessionHealth } from "./enrich/collector.js";
import { getDataDragonVersion, getProfileIcon, readCrestSvg } from "./assets/cache.js";
import { beginAssistedEnrolment, captureCurrentSession, preflightSwitch, switchToAccount } from "./switch/strategies.js";
import { createBaselineBackup, hasBaseline, latestBaselineSessionFile } from "./store/backup.js";
import { getLogger } from "./log/logger.js";
import {
  ACCOUNTS_CHANGED_CHANNEL,
  SWITCH_PROGRESS_CHANNEL,
  type AccountView,
  type AppStatus,
  type RefreshOutcome,
} from "../shared/ipc.js";

const log = getLogger();
const here = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let lastRefreshAt: string | null = null;

// ---------------------------------------------------------------- data locations
//
// Electron's default userData path is %APPDATA%\<productName>, which for this app is
// %APPDATA%\LeagueSwitcher — exactly where the vault, sessions and backups live. Left alone,
// Chromium scatters GPUCache, Code Cache, Local Storage, Network, Preferences and a dozen
// other files straight into the directory holding secrets.enc, which makes "back up my app
// data" and "what is this folder" both much worse answers than they should be.
//
// Must run before app.whenReady(): Chromium fixes these paths during startup.
app.setPath("userData", join(appPaths.root, "chromium"));

// ---------------------------------------------------------------- single instance

if (!app.requestSingleInstanceLock()) {
  // A second instance could capture and restore the session concurrently with the first.
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------- view model

/** Tier ordering, best first — used for the "sort by rank" mode. */
const TIER_ORDER = [
  "CHALLENGER", "GRANDMASTER", "MASTER", "DIAMOND", "EMERALD",
  "PLATINUM", "GOLD", "SILVER", "BRONZE", "IRON",
];

function toView(account: Account, activeId: string | null, hasSession: boolean, hasPassword: boolean): AccountView {
  const solo = account.ranked.find((r) => r.queue === "RANKED_SOLO_5x5") ?? account.ranked[0] ?? null;
  const wins = solo?.wins ?? 0;
  const losses = solo?.losses ?? 0;
  const played = wins + losses;
  const ranked = Boolean(solo && solo.tier);

  return {
    ...account,
    tierKey: (solo?.tier ?? "unranked").toLowerCase(),
    rankLabel: ranked ? `${solo!.tier} ${solo!.rank}`.trim() : "Unranked",
    rankQueue: ranked ? solo!.queue : null,
    leaguePoints: solo?.leaguePoints ?? null,
    wins,
    losses,
    // An unranked account with no games has no win rate — 0% would be a lie.
    winRate: played > 0 ? Math.round((wins / played) * 100) : null,
    placementsPlayed: ranked ? null : played,
    riotIdLabel: account.gameName ? `${account.gameName}#${account.tagLine}` : account.loginUsername,
    links: buildExternalLinks({
      gameName: account.gameName,
      tagLine: account.tagLine,
      region: account.region,
      platformId: account.platformId,
    }),
    hasStoredSession: hasSession,
    hasStoredPassword: hasPassword,
    isActive: account.id === activeId,
  };
}

async function buildAccountViews(): Promise<AccountView[]> {
  const store = getAccountStore();
  const vault = await getVault();
  const activeId = store.getActiveId();

  // Keep health honest every time the grid is built: an account whose session vanished must
  // show as needing re-enrolment before the user clicks Switch and fails.
  await refreshSessionHealth((id) => vault.hasSession(id));

  const views = store
    .list()
    .map((a) => toView(a, activeId, vault.hasSession(a.id), vault.hasCredential(a.id)));

  // Active account pinned to the top (PLAN §5), then by rank.
  return views.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    const ai = TIER_ORDER.indexOf(a.rankLabel.split(" ")[0] ?? "");
    const bi = TIER_ORDER.indexOf(b.rankLabel.split(" ")[0] ?? "");
    const aRank = ai < 0 ? 99 : ai;
    const bRank = bi < 0 ? 99 : bi;
    return aRank - bRank || a.riotIdLabel.localeCompare(b.riotIdLabel);
  });
}

// ---------------------------------------------------------------- IPC

function registerIpc(): void {
  ipcMain.handle("accounts:list", async () => buildAccountViews());

  ipcMain.handle("accounts:status", async (): Promise<AppStatus> => {
    const store = getAccountStore();
    const vault = await getVault();
    const lock = readLockfile("riot-client");
    // One process enumeration for all three answers — this endpoint is polled.
    const running = await getRunningState();

    let signedInAs: string | null = null;
    let signedInAccountId: string | null = null;
    if (lock) {
      try {
        const state = await readLoginState(lock);
        if (state.authenticated) {
          signedInAs = state.riotId ? `${state.riotId.gameName}#${state.riotId.tagLine}` : (state.loginUsername ?? null);
          signedInAccountId =
            store.list().find((a) => a.localPuuid && a.localPuuid === state.localPuuid)?.id ?? store.getActiveId();
        }
      } catch (err) {
        log.warn("could not read login state", err);
      }
    }

    return {
      riotClientRunning: running.riotClient,
      leagueClientRunning: running.leagueClient,
      gameRunning: running.game,
      signedInAs,
      signedInAccountId,
      hasApiKey: Boolean(vault.getApiKey()),
      hasBaseline: hasBaseline(),
      dataDragonVersion: await getDataDragonVersion(),
      lastRefreshAt,
      warnings: vault.warnings.map((w) => w.message).concat(getAccountStore().warnings),
    };
  });

  ipcMain.handle("accounts:refresh", async (_e, accountId?: string): Promise<RefreshOutcome> => {
    const summary = await refreshAllAccounts(accountId ? { accountIds: [accountId] } : {});
    if (summary.ran) lastRefreshAt = new Date().toISOString();
    return {
      ran: summary.ran,
      ...(summary.skippedReason ? { skippedReason: summary.skippedReason } : {}),
      succeeded: summary.succeeded,
      failed: summary.failed,
      errors: summary.results
        .filter((r) => !r.ok)
        .map((r) => ({ accountId: r.accountId, message: r.error ?? "unknown error" })),
    };
  });

  ipcMain.handle("accounts:collect", async () => {
    const result = await collectForCurrentAccount();
    return { updated: [...new Set(result.updated)], notes: result.notes };
  });

  ipcMain.handle("accounts:update", async (_e, accountId: string, changes: { label?: string | null; colorTag?: string | null }) => {
    const store = getAccountStore();
    const updated = store.update(accountId, changes);
    if (!updated) return null;
    const vault = await getVault();
    return toView(updated, store.getActiveId(), vault.hasSession(accountId), vault.hasCredential(accountId));
  });

  ipcMain.handle("accounts:remove", async (_e, accountId: string) => {
    const vault = await getVault();
    await vault.forget(accountId);
    return getAccountStore().remove(accountId);
  });

  ipcMain.handle("switch:preflight", async (_e, accountId: string) => preflightSwitch(accountId));

  ipcMain.handle("switch:start", async (_e, accountId: string, options: { confirmed: boolean }) => {
    log.info(`switch requested: ${accountId}`);
    const result = await switchToAccount(accountId, {
      confirmedCloseRunningClient: options.confirmed,
      onProgress: (progress) => {
        mainWindow?.webContents.send(SWITCH_PROGRESS_CHANNEL, { ...progress, accountId });
      },
    });
    log.info(`switch finished: ${accountId} ok=${result.ok} strategy=${result.strategy ?? "-"} ${result.elapsedMs}ms`);
    // A switch changes level/icon/region, so refresh the local view straight away.
    await collectForCurrentAccount().catch(() => undefined);
    return result;
  });

  ipcMain.handle("enrol:capture", async (_e, label?: string) => {
    const result = await captureCurrentSession(label ? { label } : {});
    return {
      ok: result.ok,
      ...(result.accountId ? { accountId: result.accountId } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.created !== undefined ? { created: result.created } : {}),
    };
  });

  ipcMain.handle("enrol:assisted", async (_e, username: string) => {
    const result = await beginAssistedEnrolment(username, {
      onProgress: (progress) => {
        mainWindow?.webContents.send(SWITCH_PROGRESS_CHANNEL, { ...progress, accountId: username });
      },
    });
    return {
      ok: result.ok,
      ...(result.accountId ? { accountId: result.accountId } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  });

  ipcMain.handle("credentials:get", async (_e, accountId: string) => {
    const vault = await getVault();
    const cred = vault.getCredential(accountId);
    return cred ? { username: cred.username, password: cred.password } : null;
  });

  ipcMain.handle("credentials:save", async (_e, accountId: string, username: string, password: string) => {
    const vault = await getVault();
    await vault.setCredential(accountId, username, password);
    log.info(`credentials updated for ${accountId}`); // the values never reach the log
    return true;
  });

  ipcMain.handle("settings:getApiKey", async () => ({ present: Boolean((await getVault()).getApiKey()) }));

  ipcMain.handle("settings:setApiKey", async (_e, key: string | null) => {
    await (await getVault()).setApiKey(key);
    return true;
  });

  ipcMain.handle("settings:openExternal", async (_e, url: string) => {
    // Only ever open http(s). A file:// or similar URL arriving here would be a way to make
    // the app launch something local on a renderer's say-so.
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
  });

  ipcMain.handle("settings:openDataFolder", async () => {
    await shell.openPath(appPaths.root);
  });

  /** P3.6 — panic restore: put the baseline snapshot back. */
  /** P5.3 — take the safety snapshot. Read-only with respect to the Riot install. */
  ipcMain.handle("settings:takeBaseline", async () => {
    const result = createBaselineBackup();
    if (!result.ok) return { ok: false, message: `Backup failed: ${result.error}` };
    if (result.captured === 0) {
      return { ok: false, message: "Nothing to back up — no Riot session file was found on this machine." };
    }
    log.info(`baseline backup taken: ${result.directory} (${result.captured} file(s))`);
    return { ok: true, message: `Saved a snapshot of ${result.captured} file(s).`, directory: result.directory };
  });

  ipcMain.handle("settings:panicRestore", async () => {
    const file = latestBaselineSessionFile();
    if (!file) return { ok: false, message: "No baseline snapshot to restore from." };

    if (await isGameRunning()) {
      return { ok: false, message: "A game is running. Close it before restoring." };
    }

    try {
      const { shutdownRiot } = await import("./riot/process.js");
      await shutdownRiot({ includeLeague: true });
      restoreSessionFromString(readFileSync(file, "utf8"));
      log.warn("panic restore performed");
      return { ok: true, message: "Restored the original session. Start the Riot Client to check." };
    } catch (err) {
      return { ok: false, message: `Restore failed: ${(err as Error).message}` };
    }
  });

  ipcMain.handle("assets:crest", async (_e, tier: string) => readCrestSvg(tier));

  ipcMain.handle("assets:icon", async (_e, iconId: number) => {
    const asset = await getProfileIcon(iconId);
    if (asset.source === "missing" || !existsSync(asset.path)) return null;
    // Returned as a data URI: the renderer has no filesystem access, and this keeps it that way.
    return `data:image/png;base64,${readFileSync(asset.path).toString("base64")}`;
  });
}

// ---------------------------------------------------------------- window

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    show: false,
    backgroundColor: "#0A0D13",
    title: "LeagueSwitcher",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, "..", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // the preload needs `require` for electron's own modules
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // Env-gated screenshot hook, for verifying the UI without a human at the screen.
  // Capturing through webContents rather than the desktop is the only reliable way: a
  // screen grab picks up whatever window happens to be in front, and on this machine the
  // Riot Client frequently is.
  if (process.env.LEAGUESWITCHER_SCREENSHOT) {
    const target = process.env.LEAGUESWITCHER_SCREENSHOT;
    const delayMs = Number(process.env.LEAGUESWITCHER_SCREENSHOT_DELAY ?? 6000);
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(() => {
        void mainWindow?.webContents.capturePage().then(async (image) => {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(target, image.toPNG());
          log.info(`screenshot written to ${target}`);
          if (process.env.LEAGUESWITCHER_SCREENSHOT_EXIT) app.quit();
        });
      }, delayMs);
    });
  }

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) {
    void mainWindow.loadURL(devServer);
  } else {
    void mainWindow.loadFile(join(here, "..", "renderer", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Never let the renderer navigate away or spawn windows — it only ever shows our own UI.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

/** P3.7 — tray icon, so the app can live in the background between switches. */
function createTray(): void {
  const iconPath = join(here, "..", "..", "assets", "icon.png");
  const image = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();

  try {
    tray = new Tray(image);
    tray.setToolTip("LeagueSwitcher");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Show LeagueSwitcher", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      ])
    );
    tray.on("double-click", () => { mainWindow?.show(); mainWindow?.focus(); });
  } catch (err) {
    // A tray icon failing is not worth refusing to start over.
    log.warn("could not create tray icon", err);
  }
}

// ---------------------------------------------------------------- lifecycle

void app.whenReady().then(async () => {
  log.info(`LeagueSwitcher starting (${isDev ? "dev" : "packaged"})`);

  // Load the vault early so a migration or corruption warning is ready for the first status call.
  await getVault();
  registerIpc();
  createWindow();
  createTray();

  // The launch refresh (PLAN §4). Cached values are already on screen by now; this updates
  // them in place, and a missing API key is a no-op rather than an error.
  void (async () => {
    try {
      await collectForCurrentAccount();
      // Heal any stored session that lost its profile before refreshing, so an orphan
      // cannot quietly persist across launches.
      await adoptOrphanSessions().catch(() => undefined);
      const summary = await refreshAllAccounts();
      if (summary.ran) lastRefreshAt = new Date().toISOString();
      mainWindow?.webContents.send(ACCOUNTS_CHANGED_CHANNEL);
      log.info(`launch refresh: ${summary.succeeded} ok, ${summary.failed} failed`);

      // When a refresh does nothing, say why. "No Riot API key" on screen above an intact
      // vault was diagnosable only by guesswork until this line existed; the vault's own
      // warnings distinguish "there is no key" from "the key could not be read just now".
      if (!summary.ran) {
        const v = await getVault();
        // Log WHICH file was consulted, not just the outcome. Three rounds of this were spent
        // inferring that from timing; the path, its existence and its size settle it outright.
        const { statSync: st, existsSync: ex } = await import("node:fs");
        const size = (() => { try { return st(appPaths.secrets).size; } catch { return -1; } })();
        log.warn(
          `launch refresh skipped (${summary.skippedReason ?? "unknown"}); ` +
            `keyState=${v.getApiKey() ? "present" : "absent"}; ` +
            `root=${appPaths.root}; secrets=${appPaths.secrets}; ` +
            `exists=${ex(appPaths.secrets)}; size=${size}; ` +
            `APPDATA=${process.env.APPDATA ?? "(unset)"}; ` +
            `vaultWarnings=${JSON.stringify(v.warnings.map((w) => `${w.kind}: ${w.detail ?? w.message}`))}`
        );
      }
    } catch (err) {
      log.warn("launch refresh failed", err);
    }
  })();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
