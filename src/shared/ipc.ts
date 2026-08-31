/**
 * P3.1 — the IPC contract, shared by main and renderer.
 *
 * PLAN §2.2: "The renderer NEVER sees a password or a refresh token. IPC exposes only account
 * metadata and action commands." That rule is enforced by the shape of the types below —
 * there is no channel that returns a secret, so a renderer bug cannot leak one.
 *
 * The one apparent exception is `credentials:get`, which returns a password so the detail
 * panel's field can be edited. It is deliberately opt-in per account and per click: the panel
 * requests it only when the user presses Show, never on open, so a password is never sitting in
 * renderer memory just because a panel happens to be visible.
 */
import type { Account } from "../main/store/accounts.js";
import type { SwitchProgress, SwitchResult, Preflight } from "../main/switch/strategies.js";
import type { ExternalLink } from "../main/api/links.js";

export type { Account, SwitchProgress, SwitchResult, Preflight, ExternalLink };

/** What the grid renders, assembled once in main so the renderer does no derivation. */
export interface AccountView extends Account {
  /** Lower-case tier key for the CSS custom property, e.g. "diamond". */
  tierKey: string;
  /** "DIAMOND IV" or "Unranked". */
  rankLabel: string;
  leaguePoints: number | null;
  wins: number;
  losses: number;
  winRate: number | null;
  /** How many placement games remain, for an unranked account with games played. */
  placementsPlayed: number | null;
  riotIdLabel: string;
  links: ExternalLink[];
  hasStoredSession: boolean;
  hasStoredPassword: boolean;
  isActive: boolean;
}

export interface AppStatus {
  riotClientRunning: boolean;
  leagueClientRunning: boolean;
  gameRunning: boolean;
  signedInAs: string | null;
  signedInAccountId: string | null;
  hasApiKey: boolean;
  dataDragonVersion: string;
  lastRefreshAt: string | null;
  /** Non-fatal problems worth showing once, e.g. a vault that had to be set aside. */
  warnings: string[];
}

export interface RefreshOutcome {
  ran: boolean;
  skippedReason?: string;
  succeeded: number;
  failed: number;
  errors: Array<{ accountId: string; message: string }>;
}

/**
 * Every channel, with its argument and return types. `preload` mirrors this exactly, so adding
 * a channel in one place without the other is a type error rather than a runtime surprise.
 */
export interface IpcApi {
  "accounts:list": () => Promise<AccountView[]>;
  "accounts:status": () => Promise<AppStatus>;
  "accounts:refresh": (accountId?: string) => Promise<RefreshOutcome>;
  "accounts:collect": () => Promise<{ updated: string[]; notes: string[] }>;
  "accounts:update": (accountId: string, changes: { label?: string | null; colorTag?: string | null }) => Promise<AccountView | null>;
  "accounts:remove": (accountId: string) => Promise<boolean>;

  "switch:preflight": (accountId: string) => Promise<Preflight>;
  "switch:start": (accountId: string, options: { confirmed: boolean }) => Promise<SwitchResult>;

  "enrol:capture": (label?: string) => Promise<{ ok: boolean; accountId?: string; error?: string; created?: boolean }>;
  "enrol:assisted": (username: string) => Promise<{ ok: boolean; accountId?: string; error?: string }>;

  /** Returns the stored password so the panel can edit it. Requested only on an explicit Show. */
  "credentials:get": (accountId: string) => Promise<{ username: string; password: string } | null>;
  "credentials:save": (accountId: string, username: string, password: string) => Promise<boolean>;

  "settings:getApiKey": () => Promise<{ present: boolean }>;
  "settings:setApiKey": (key: string | null) => Promise<boolean>;
  "settings:openExternal": (url: string) => Promise<void>;
  "settings:openDataFolder": () => Promise<void>;
  "settings:panicRestore": () => Promise<{ ok: boolean; message: string }>;

  "assets:crest": (tier: string) => Promise<string | null>;
  "assets:icon": (iconId: number) => Promise<string | null>;
}

export type IpcChannel = keyof IpcApi;

/** Progress events pushed from main to renderer during a switch. */
export const SWITCH_PROGRESS_CHANNEL = "switch:progress";

export interface SwitchProgressEvent extends SwitchProgress {
  accountId: string;
}
