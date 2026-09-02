/**
 * P2.4 — account metadata and the stats cache.
 *
 * `accounts.json` holds NOTHING sensitive: no passwords, no tokens. Passwords live in the
 * vault, sessions live encrypted beside it. This file is the thing the UI renders instantly on
 * launch, before the API refresh has landed (PLAN §4.3), so it is deliberately plain JSON that
 * can be read without decrypting anything.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appPaths } from "../riot/paths.js";

export const ACCOUNTS_SCHEMA_VERSION = 1;

export interface RankEntry {
  queue: "RANKED_SOLO_5x5" | "RANKED_FLEX_SR";
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  hotStreak?: boolean;
  veteran?: boolean;
  freshBlood?: boolean;
  inactive?: boolean;
}

/** Green valid · amber stale · red needs re-enrolment (PLAN §5). */
export type SessionHealth = "valid" | "stale" | "missing";

export interface Account {
  /** Stable id, derived from the login username. */
  id: string;
  /** The username typed at Riot's login screen. Not a Riot ID. */
  loginUsername: string;
  /** Riot ID — the durable, key-independent identifier (PLAN §4.2). */
  gameName: string | null;
  tagLine: string | null;

  /** e.g. "NA1". Read from the client's own session claims after a switch (EXP-4). */
  platformId: string | null;
  /** e.g. "NA". Derived from platformId. */
  region: string | null;

  /**
   * The Riot Client's local puuid.
   * ⚠️ Key-scoped and NOT usable against the public API — for matching a session to a profile
   * only (RESEARCH §9).
   */
  localPuuid: string | null;

  /**
   * puuid as issued to OUR API key, plus a fingerprint of the key that issued it. If the key
   * changes, every cached puuid is invalid and must be re-resolved (PLAN §4.2).
   */
  puuid: string | null;
  puuidKeyFingerprint: string | null;

  summonerLevel: number | null;
  profileIconId: number | null;
  ranked: RankEntry[];

  label: string | null;
  colorTag: string | null;
  order: number;

  enrolledAt: string | null;
  lastSwitchedAt: string | null;
  lastUpdated: string | null;
  /** Populated when the last refresh for this account failed — surfaced per-card. */
  lastError: string | null;

  sessionHealth: SessionHealth;
  /** From max_duration_between_restores; drives the amber "stale" state. */
  sessionDaysRemaining: number | null;
}

interface AccountsFile {
  version: number;
  accounts: Account[];
  /** Which account the Riot Client is currently signed in as. */
  activeAccountId: string | null;
  updatedAt: string;
}

export function createAccount(id: string, loginUsername: string, partial: Partial<Account> = {}): Account {
  return {
    id,
    loginUsername,
    gameName: null,
    tagLine: null,
    platformId: null,
    region: null,
    localPuuid: null,
    puuid: null,
    puuidKeyFingerprint: null,
    summonerLevel: null,
    profileIconId: null,
    ranked: [],
    label: null,
    colorTag: null,
    order: 0,
    enrolledAt: null,
    lastSwitchedAt: null,
    lastUpdated: null,
    lastError: null,
    sessionHealth: "missing",
    sessionDaysRemaining: null,
    ...partial,
  };
}

const EMPTY_FILE = (): AccountsFile => ({
  version: ACCOUNTS_SCHEMA_VERSION,
  accounts: [],
  activeAccountId: null,
  updatedAt: new Date().toISOString(),
});

let tempCounter = 0;

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  // Unique per call: pid+timestamp alone collided on ~46% of back-to-back writes, which is
  // harmless while every write is synchronous but a trap the moment one is not.
  const temp = join(dirname(path), `.${process.pid}-${Date.now()}-${(tempCounter++).toString(36)}.tmp`);
  writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  renameSync(temp, path);
}

export class AccountStore {
  private data: AccountsFile = EMPTY_FILE();
  private loaded = false;
  private stamp = "";
  readonly warnings: string[] = [];

  /**
   * Read accounts.json, reloading whenever the file on disk has changed underneath us.
   *
   * This used to load once and cache forever, which silently lost data: `save()` writes the
   * whole in-memory snapshot back, so any process holding a stale copy overwrote whatever
   * another process had written since. Assisted enrolment is the worst case — it runs for
   * minutes while the user signs in, so the copy it loaded at startup is almost guaranteed to
   * be stale by the time it saves. That is how an enrolment could report success, store the
   * session and password in the vault, and still leave no account in accounts.json.
   *
   * Keyed on mtime + size rather than a watcher: cheap, synchronous, and no lifecycle to leak.
   * This narrows the race to sub-millisecond rather than eliminating it — a true fix needs a
   * lock file, which is only worth it if two writers ever genuinely overlap.
   */
  load(): void {
    if (!existsSync(appPaths.accounts)) {
      // "The file is gone" wipes every account, so do not conclude it from one stat.
      // Windows can report a file as briefly absent while it is being replaced, and
      // atomicWriteJson renames over this exact path.
      for (let i = 0; i < 3 && !existsSync(appPaths.accounts); i++) {
        try {
          statSync(dirname(appPaths.accounts));
        } catch {
          /* ignore — this is a cheap way to yield without going async */
        }
      }
    }

    if (!existsSync(appPaths.accounts)) {
      if (this.loaded && this.data.accounts.length === 0) return;
      this.loaded = true;
      this.data = EMPTY_FILE();
      // Clear the stamp, or the staleness check below will match an unchanged file on the
      // next call and early-return with this empty data — permanently.
      //
      // That is exactly what happened: one transient miss emptied the store, every later
      // load() short-circuited, every update() then found no account and silently no-op'd,
      // so accounts.json was never rewritten, its mtime never changed, and the app stayed
      // empty until it was restarted. Accounts "randomly disappeared" and came back on
      // relaunch.
      this.stamp = "";
      return;
    }

    let stamp = "";
    try {
      const st = statSync(appPaths.accounts);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      /* fall through to a re-read */
    }
    // Never treat an empty in-memory store as up to date. If the stamp matches but we hold
    // nothing while the file is non-empty, something emptied us — re-read rather than serve it.
    const looksEmptied = this.data.accounts.length === 0;
    if (this.loaded && stamp !== "" && stamp === this.stamp && !looksEmptied) return;
    this.loaded = true;
    this.stamp = stamp;

    try {
      const parsed = JSON.parse(readFileSync(appPaths.accounts, "utf8")) as AccountsFile;
      this.data = migrate(parsed);
    } catch (err) {
      // A corrupt accounts.json costs metadata, never credentials or sessions — those are in
      // the vault. Set it aside and carry on rather than refusing to start.
      const aside = `${appPaths.accounts}.corrupt-${Date.now()}`;
      try {
        renameSync(appPaths.accounts, aside);
      } catch {
        /* best effort */
      }
      this.data = EMPTY_FILE();
      this.warnings.push(`accounts.json was unreadable and has been set aside at ${aside} (${(err as Error).message})`);
    }
  }

  /** Force the next read to come from disk, ignoring the staleness stamp. */
  reload(): void {
    this.loaded = false;
    this.stamp = "";
    this.load();
  }

  /** Drain warnings so a caller can log them once rather than on every poll. */
  takeWarnings(): string[] {
    return this.warnings.splice(0, this.warnings.length);
  }

  save(): void {
    this.data.updatedAt = new Date().toISOString();
    atomicWriteJson(appPaths.accounts, this.data);
    // Record what we just wrote, so the next load() does not treat our own write as a foreign
    // change and pointlessly re-read it.
    try {
      const st = statSync(appPaths.accounts);
      this.stamp = `${st.mtimeMs}:${st.size}`;
      this.loaded = true;
    } catch {
      this.stamp = "";
    }
  }

  list(): Account[] {
    this.load();
    return [...this.data.accounts].sort((a, b) => a.order - b.order || a.loginUsername.localeCompare(b.loginUsername));
  }

  get(id: string): Account | null {
    this.load();
    return this.data.accounts.find((a) => a.id === id) ?? null;
  }

  /** Find by id, login username, or Riot ID — the CLI accepts any of them. */
  find(needle: string): Account | null {
    this.load();
    const lower = needle.trim().toLowerCase();
    return (
      this.data.accounts.find((a) => a.id.toLowerCase() === lower) ??
      this.data.accounts.find((a) => a.loginUsername.toLowerCase() === lower) ??
      this.data.accounts.find((a) => `${a.gameName}#${a.tagLine}`.toLowerCase() === lower) ??
      this.data.accounts.find((a) => (a.gameName ?? "").toLowerCase() === lower) ??
      null
    );
  }

  upsert(account: Account): Account {
    this.load();
    const index = this.data.accounts.findIndex((a) => a.id === account.id);
    if (index >= 0) this.data.accounts[index] = account;
    else {
      account.order = account.order || this.data.accounts.length;
      this.data.accounts.push(account);
    }
    this.save();
    return account;
  }

  /** Merge a partial update into an existing account. */
  update(id: string, changes: Partial<Account>): Account | null {
    this.load();
    const existing = this.get(id);
    if (!existing) {
      // Silently doing nothing here is how an emptied store hid itself: switches and refreshes
      // both go through update(), so every write became a no-op and nothing ever reached disk.
      // A miss is now recorded, because "the account I am updating does not exist" is never
      // normal.
      this.warnings.push(`update("${id}") found no such account — the store may have been emptied`);
      return null;
    }
    return this.upsert({ ...existing, ...changes, id: existing.id });
  }

  remove(id: string): boolean {
    this.load();
    const before = this.data.accounts.length;
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (this.data.activeAccountId === id) this.data.activeAccountId = null;
    const removed = this.data.accounts.length < before;
    if (removed) this.save();
    return removed;
  }

  getActiveId(): string | null {
    this.load();
    return this.data.activeAccountId;
  }

  setActive(id: string | null): void {
    this.load();
    this.data.activeAccountId = id;
    this.save();
  }
}

/** Bring an older file forward. Unknown future versions are used as-is rather than discarded. */
function migrate(file: AccountsFile): AccountsFile {
  const version = file.version ?? 0;
  const accounts = (file.accounts ?? []).map((a) => createAccount(a.id, a.loginUsername, a));
  return {
    version: Math.max(version, ACCOUNTS_SCHEMA_VERSION),
    accounts,
    activeAccountId: file.activeAccountId ?? null,
    updatedAt: file.updatedAt ?? new Date().toISOString(),
  };
}

/** Platform id -> the short region code shown on a card. */
export const PLATFORM_TO_REGION: Record<string, string> = {
  NA1: "NA", EUW1: "EUW", EUN1: "EUNE", KR: "KR", BR1: "BR",
  LA1: "LAN", LA2: "LAS", OC1: "OCE", TR1: "TR", RU: "RU", JP1: "JP",
  PH2: "PH", SG2: "SG", TH2: "TH", TW2: "TW", VN2: "VN",
};

export function regionFromPlatform(platformId: string | null): string | null {
  if (!platformId) return null;
  return PLATFORM_TO_REGION[platformId.toUpperCase()] ?? platformId.toUpperCase();
}

let singleton: AccountStore | null = null;

export function getAccountStore(): AccountStore {
  if (!singleton) {
    singleton = new AccountStore();
    singleton.load();
  }
  return singleton;
}

export function resetAccountStoreForTests(): void {
  singleton = null;
}
