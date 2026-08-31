/**
 * Every filesystem location the app touches, in one place.
 *
 * Two rules this file exists to enforce (PLAN §2.3, §7 rule 2):
 *   - Runtime data lives under %APPDATA%\LeagueSwitcher\ — never in the repository.
 *   - Riot's own files are only ever addressed through these constants, so a path typo
 *     cannot send a write somewhere unexpected.
 */
import { join } from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`environment variable ${name} is not set — this app is Windows-only`);
  return value;
}

const LOCALAPPDATA = () => required("LOCALAPPDATA");
const APPDATA = () => required("APPDATA");

/** Riot's default install root. Overridable because not everyone installs to C:. */
export const RIOT_INSTALL_ROOT = process.env.LEAGUESWITCHER_RIOT_ROOT ?? "C:\\Riot Games";

export const riotPaths = {
  /** `Riot Client:<pid>:<port>:<password>:https` — written while the client runs. */
  get rcLockfile() {
    return join(LOCALAPPDATA(), "Riot Games", "Riot Client", "Config", "lockfile");
  },
  /** `LeagueClient:<pid>:<port>:<password>:https` — written while League runs. */
  get lcuLockfile() {
    return join(RIOT_INSTALL_ROOT, "League of Legends", "lockfile");
  },
  /** THE session file. The refresh token lives here; this is what a switch swaps. */
  get session() {
    return join(LOCALAPPDATA(), "Riot Games", "Riot Client", "Data", "RiotGamesPrivateSettings.yaml");
  },
  /** Region and locale config. EXP-4 says a switch should not need to write this. */
  get clientSettings() {
    return join(LOCALAPPDATA(), "Riot Games", "Riot Client", "Config", "RiotClientSettings.yaml");
  },
  get rcServices() {
    return join(RIOT_INSTALL_ROOT, "Riot Client", "RiotClientServices.exe");
  },
} as const;

/** Everything this app owns. Nothing here is ever inside the git working tree. */
export const appPaths = {
  get root() {
    return process.env.LEAGUESWITCHER_DATA_DIR ?? join(APPDATA(), "LeagueSwitcher");
  },
  get accounts() {
    return join(appPaths.root, "accounts.json");
  },
  /** DPAPI-encrypted { accountId: { username, password } } plus the API key. */
  get secrets() {
    return join(appPaths.root, "secrets.enc");
  },
  /** One DPAPI-encrypted session file per account. */
  get sessions() {
    return join(appPaths.root, "sessions");
  },
  sessionFile(accountId: string) {
    return join(appPaths.sessions, `${accountId}.enc`);
  },
  get backups() {
    return join(appPaths.root, "backups");
  },
  get cache() {
    return join(appPaths.root, "cache");
  },
  get logs() {
    return join(appPaths.root, "logs");
  },
  get logFile() {
    return join(appPaths.logs, "app.log");
  },
  get probeResults() {
    return join(appPaths.root, "probe-results");
  },
  /** Legacy plaintext key file. Read once, migrated into the vault, then deleted. */
  get legacyApiKeyFile() {
    return join(appPaths.root, "riot-api-key.txt");
  },
  /** Legacy plaintext credentials. Same: migrate at first run, then delete (PLAN §7 rule 8). */
  get legacyCredentialsFile() {
    return join(appPaths.root, "test-credentials.json");
  },
} as const;
