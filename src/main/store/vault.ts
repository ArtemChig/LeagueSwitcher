/**
 * P1.5 — the encrypted vault.
 *
 * Holds the three things that must never be readable on disk or committable to the repo:
 * account passwords, the Riot API key, and each account's captured session file.
 *
 *   %APPDATA%\LeagueSwitcher\secrets.enc      one DPAPI blob: credentials + API key
 *   %APPDATA%\LeagueSwitcher\sessions\<id>.enc  one DPAPI blob per captured session
 *
 * Design decisions worth stating:
 *
 *   - The credential store is ONE blob, not one per account. DPAPI costs ~200ms per call, and
 *     ten accounts would otherwise mean ten round-trips on every read. Sessions stay separate
 *     because they are large and are read one at a time, during a switch.
 *   - Writes are atomic (temp + rename). A crash mid-write must not destroy the vault; losing
 *     a session blob means an account has to be enrolled again through a captcha.
 *   - A vault that fails to decrypt is preserved, not deleted. It is renamed aside so the user
 *     can recover it, and the app carries on with an empty vault rather than refusing to start.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { appPaths } from "../riot/paths.js";
import { registerSecret } from "../log/redact.js";
import { protect, unprotect } from "./dpapi.js";

export const VAULT_SCHEMA_VERSION = 1;

export interface StoredCredential {
  username: string;
  password: string;
  /** When the password was last edited here — shown in the detail panel. */
  updatedAt: string;
}

interface VaultContents {
  version: number;
  apiKey: string | null;
  credentials: Record<string, StoredCredential>;
}

const EMPTY: VaultContents = { version: VAULT_SCHEMA_VERSION, apiKey: null, credentials: {} };

/** Non-fatal problems worth surfacing in the UI rather than throwing. */
export interface VaultWarning {
  kind: "corrupt" | "migrated" | "unreadable-session";
  message: string;
  detail?: string;
}

function atomicWrite(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${process.pid}-${Date.now()}.tmp`);
  writeFileSync(temp, data);
  renameSync(temp, path);
}

export class Vault {
  private contents: VaultContents = { ...EMPTY, credentials: {} };
  private loaded = false;
  private stamp = "";
  readonly warnings: VaultWarning[] = [];

  /**
   * Read and decrypt, reloading whenever secrets.enc has changed underneath us.
   *
   * This used to decrypt once and cache forever. Because save() re-encrypts the whole snapshot,
   * a process holding a stale copy erased anything another process had written since — the same
   * defect as AccountStore, with worse consequences, because what gets erased here is a
   * password, a captured session or the API key.
   *
   * It was observed: enrolling two accounts while another process held the vault dropped the
   * stored API key, and the next refresh reported "No Riot API key is configured" for a key
   * that had been saved minutes earlier.
   *
   * A vault that will not decrypt is moved aside rather than destroyed — DPAPI failure usually
   * means "a different Windows user" or "restored from a backup of another machine", both of
   * which the user may want to recover from.
   */
  async load(): Promise<void> {
    if (!existsSync(appPaths.secrets)) {
      if (this.loaded) return;
      this.loaded = true;
      this.contents = { ...EMPTY, credentials: {} };
      await this.migrateLegacyPlaintext();
      return;
    }

    let stamp = "";
    try {
      const st = statSync(appPaths.secrets);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      /* fall through and re-read */
    }
    if (this.loaded && stamp !== "" && stamp === this.stamp) return;
    this.loaded = true;
    this.stamp = stamp;

    try {
      const json = await unprotect(readFileSync(appPaths.secrets));
      const parsed = JSON.parse(json) as VaultContents;
      this.contents = {
        version: parsed.version ?? VAULT_SCHEMA_VERSION,
        apiKey: parsed.apiKey ?? null,
        credentials: parsed.credentials ?? {},
      };
      this.registerAllSecrets();
    } catch (err) {
      const aside = `${appPaths.secrets}.corrupt-${Date.now()}`;
      try {
        renameSync(appPaths.secrets, aside);
      } catch {
        /* best effort — the important thing is not to crash */
      }
      this.contents = { ...EMPTY, credentials: {} };
      this.warnings.push({
        kind: "corrupt",
        message: "The secrets vault could not be decrypted and has been set aside. Re-enter your API key and passwords.",
        detail: `${(err as Error).message} — previous file kept at ${aside}`,
      });
    }

    await this.migrateLegacyPlaintext();
  }

  /** Everything the vault knows is a secret goes to the redactor, so it can never be logged. */
  private registerAllSecrets(): void {
    if (this.contents.apiKey) registerSecret(this.contents.apiKey);
    for (const cred of Object.values(this.contents.credentials)) registerSecret(cred.password);
  }

  private async save(): Promise<void> {
    this.contents.version = VAULT_SCHEMA_VERSION;
    atomicWrite(appPaths.secrets, await protect(JSON.stringify(this.contents)));
    // Remember our own write so the next load() does not mistake it for a foreign change.
    try {
      const st = statSync(appPaths.secrets);
      this.stamp = `${st.mtimeMs}:${st.size}`;
      this.loaded = true;
    } catch {
      this.stamp = "";
    }
  }

  /**
   * PLAN §7 rule 8: plaintext credential and key files must be migrated into the vault and
   * then deleted. Runs on every load so a file dropped in later is picked up.
   */
  private async migrateLegacyPlaintext(): Promise<void> {
    let changed = false;

    if (existsSync(appPaths.legacyApiKeyFile)) {
      try {
        const key = readFileSync(appPaths.legacyApiKeyFile, "utf8").trim();
        if (key) {
          registerSecret(key);
          this.contents.apiKey = key;
          changed = true;
          this.warnings.push({
            kind: "migrated",
            message: "Imported riot-api-key.txt into the encrypted vault and deleted the plaintext file.",
          });
        }
        unlinkSync(appPaths.legacyApiKeyFile);
      } catch (err) {
        this.warnings.push({
          kind: "migrated",
          message: "Could not migrate riot-api-key.txt.",
          detail: (err as Error).message,
        });
      }
    }

    if (existsSync(appPaths.legacyCredentialsFile)) {
      try {
        const raw = JSON.parse(readFileSync(appPaths.legacyCredentialsFile, "utf8")) as unknown;
        let imported = 0;
        for (const entry of normaliseLegacyCredentials(raw)) {
          const id = accountIdFromUsername(entry.username);
          if (this.contents.credentials[id]) continue;
          registerSecret(entry.password);
          this.contents.credentials[id] = {
            username: entry.username,
            password: entry.password,
            updatedAt: new Date().toISOString(),
          };
          imported++;
        }
        if (imported > 0) changed = true;
        unlinkSync(appPaths.legacyCredentialsFile);
        this.warnings.push({
          kind: "migrated",
          message: `Imported ${imported} credential(s) from test-credentials.json into the encrypted vault and deleted the plaintext file.`,
        });
      } catch (err) {
        this.warnings.push({
          kind: "migrated",
          message: "Could not migrate test-credentials.json — it has been left in place.",
          detail: (err as Error).message,
        });
      }
    }

    if (changed) await this.save();
  }

  // ------------------------------------------------------------------ API key

  getApiKey(): string | null {
    return this.contents.apiKey;
  }

  async setApiKey(key: string | null): Promise<void> {
    const trimmed = key?.trim() ?? null;
    if (trimmed) registerSecret(trimmed);
    this.contents.apiKey = trimmed && trimmed.length > 0 ? trimmed : null;
    await this.save();
  }

  // ------------------------------------------------------------------ credentials

  getCredential(accountId: string): StoredCredential | null {
    return this.contents.credentials[accountId] ?? null;
  }

  hasCredential(accountId: string): boolean {
    return accountId in this.contents.credentials;
  }

  listCredentialAccountIds(): string[] {
    return Object.keys(this.contents.credentials);
  }

  /**
   * Store or update a credential. This writes to the vault ONLY — it never re-authenticates
   * (PLAN §5: the existing session keeps working; Re-enrol is the fix if Riot invalidated it).
   */
  async setCredential(accountId: string, username: string, password: string): Promise<void> {
    registerSecret(password);
    this.contents.credentials[accountId] = { username, password, updatedAt: new Date().toISOString() };
    await this.save();
  }

  async deleteCredential(accountId: string): Promise<void> {
    delete this.contents.credentials[accountId];
    await this.save();
  }

  // ------------------------------------------------------------------ sessions

  hasSession(accountId: string): boolean {
    return existsSync(appPaths.sessionFile(accountId));
  }

  listSessionAccountIds(): string[] {
    if (!existsSync(appPaths.sessions)) return [];
    return readdirSync(appPaths.sessions)
      .filter((f) => f.endsWith(".enc"))
      .map((f) => f.slice(0, -4));
  }

  /** Encrypt a captured session file's contents into the vault. */
  async putSession(accountId: string, sessionYaml: string): Promise<void> {
    atomicWrite(appPaths.sessionFile(accountId), await protect(sessionYaml));
  }

  /**
   * Decrypt a stored session. Returns null when there is none, and records a warning rather
   * than throwing when one exists but will not decrypt — a switch can then fall back to
   * re-enrolment instead of crashing.
   */
  async getSession(accountId: string): Promise<string | null> {
    const path = appPaths.sessionFile(accountId);
    if (!existsSync(path)) return null;
    try {
      return await unprotect(readFileSync(path));
    } catch (err) {
      this.warnings.push({
        kind: "unreadable-session",
        message: `The stored session for ${accountId} could not be decrypted. That account needs re-enrolling.`,
        detail: (err as Error).message,
      });
      return null;
    }
  }

  async deleteSession(accountId: string): Promise<void> {
    const path = appPaths.sessionFile(accountId);
    if (existsSync(path)) unlinkSync(path);
  }

  /** Remove everything for one account. */
  async forget(accountId: string): Promise<void> {
    await this.deleteCredential(accountId);
    await this.deleteSession(accountId);
  }
}

/** Stable id from a login username. Lowercased so case differences do not create duplicates. */
export function accountIdFromUsername(username: string): string {
  return username.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "account";
}

/**
 * The legacy credentials file's shape was never pinned down, so accept the plausible ones:
 * an array of objects, or an object keyed by username. Anything unrecognised is skipped rather
 * than guessed at.
 */
function normaliseLegacyCredentials(raw: unknown): Array<{ username: string; password: string }> {
  const out: Array<{ username: string; password: string }> = [];

  const push = (username: unknown, password: unknown) => {
    if (typeof username === "string" && typeof password === "string" && username && password) {
      out.push({ username, password });
    }
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        push(e.username ?? e.user ?? e.login, e.password ?? e.pass);
      }
    }
    return out;
  }

  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.accounts)) return normaliseLegacyCredentials(obj.accounts);
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") push(key, value);
      else if (value && typeof value === "object") {
        const v = value as Record<string, unknown>;
        push(v.username ?? key, v.password ?? v.pass);
      }
    }
  }

  return out;
}

let singleton: Vault | null = null;

/** The process-wide vault. */
export async function getVault(): Promise<Vault> {
  if (!singleton) {
    singleton = new Vault();
    await singleton.load();
  }
  return singleton;
}

/** Test-only: drop the singleton so a fresh data dir is picked up. */
export function resetVaultForTests(): void {
  singleton = null;
}
