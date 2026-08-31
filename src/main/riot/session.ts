/**
 * P1.4 — the session file: capture, restore, validate, diff.
 *
 * `RiotGamesPrivateSettings.yaml` holds the long-lived OAuth refresh token. Copying it out and
 * back is the entire switch mechanism, proven by EXP-1 (a wiped file leaves the client at the
 * login screen; a restored one reaches `authenticated` in ~2 seconds).
 *
 * Notes that matter for correctness:
 *   - The file is parsed with targeted regexes, not a YAML library. Only a handful of scalars
 *     are ever needed, and a full parse/serialise round-trip risks reformatting a file Riot
 *     wrote — the safest edit to this file is no edit at all. Captures are byte-for-byte copies.
 *   - Token VALUES never leave this module except through `readSessionSecrets`, and everything
 *     read is registered with the redactor first.
 *   - Writes are atomic (temp file + rename) so a crash mid-write cannot leave a truncated
 *     session, which would sign the user out of an account whose session was not yet captured.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { registerSecret } from "../log/redact.js";
import { riotPaths } from "./paths.js";

/** Safe to log, safe to persist: token values are reduced to length + fingerprint. */
export interface SessionSummary {
  present: boolean;
  path: string;
  bytes: number;
  sha256: string;
  mtime: string;
  /** True when a refresh_token with a plausible value is present. */
  signedIn: boolean;
  refreshToken: TokenInfo | null;
  idToken: TokenInfo | null;
  tdid: TokenInfo | null;
  refreshTokenWriteCount: number | null;
  lastTokenCreationTime: number | null;
  originalTokenCreationTime: number | null;
  maxDurationBetweenRestores: number | null;
  isDpopBound: boolean;
  /** Days until the session must be restored again, from max_duration_between_restores. */
  daysUntilExpiry: number | null;
}

export interface TokenInfo {
  length: number;
  /** SHA256 prefix. Lets the UI say "the token changed" without ever showing it. */
  fingerprint: string;
}

/** Token values in the clear. Only the vault and the auth strategies may call this. */
export interface SessionSecrets {
  refreshToken: string | null;
  idToken: string | null;
  isDpopBound: boolean;
}

const EMPTY_SUMMARY = (path: string): SessionSummary => ({
  present: false,
  path,
  bytes: 0,
  sha256: "",
  mtime: new Date(0).toISOString(),
  signedIn: false,
  refreshToken: null,
  idToken: null,
  tdid: null,
  refreshTokenWriteCount: null,
  lastTokenCreationTime: null,
  originalTokenCreationTime: null,
  maxDurationBetweenRestores: null,
  isDpopBound: false,
  daysUntilExpiry: null,
});

function scalar(raw: string, key: string): string | null {
  const m = raw.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m"));
  if (!m?.[1]) return null;
  const value = m[1].replace(/^"|"$/g, "");
  return value === "null" || value === "[]" || value === "" ? null : value;
}

function numeric(raw: string, key: string): number | null {
  const v = scalar(raw, key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function tokenInfo(raw: string, key: string): TokenInfo | null {
  const v = scalar(raw, key);
  if (!v) return null;
  registerSecret(v);
  return { length: v.length, fingerprint: createHash("sha256").update(v).digest("hex").slice(0, 12) };
}

/** Summarise a session file. Always safe to log or store. */
export function summariseSession(path: string = riotPaths.session): SessionSummary {
  if (!existsSync(path)) return EMPTY_SUMMARY(path);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return EMPTY_SUMMARY(path);
  }

  const refreshToken = tokenInfo(raw, "refresh_token");
  const lastCreation = numeric(raw, "last_token_creation_time");
  const maxDuration = numeric(raw, "max_duration_between_restores");

  let daysUntilExpiry: number | null = null;
  if (lastCreation !== null && maxDuration !== null) {
    // last_token_creation_time is epoch MILLISECONDS; max_duration_between_restores is SECONDS.
    const expiresAt = lastCreation + maxDuration * 1000;
    daysUntilExpiry = Math.round((expiresAt - Date.now()) / 86_400_000);
  }

  return {
    present: true,
    path,
    bytes: Buffer.byteLength(raw),
    sha256: createHash("sha256").update(raw).digest("hex"),
    mtime: statSync(path).mtime.toISOString(),
    signedIn: refreshToken !== null && refreshToken.length > 100,
    refreshToken,
    idToken: tokenInfo(raw, "id_token"),
    tdid: tokenInfo(raw, "value"),
    refreshTokenWriteCount: numeric(raw, "refresh_token_write_count"),
    lastTokenCreationTime: lastCreation,
    originalTokenCreationTime: numeric(raw, "original_token_creation_time"),
    maxDurationBetweenRestores: maxDuration,
    isDpopBound: scalar(raw, "is_dpop_bound") === "true",
    daysUntilExpiry,
  };
}

/**
 * Token values in the clear, for injection paths. Everything returned is registered with the
 * redactor first, so even an accidental log of the result comes out scrubbed.
 */
export function readSessionSecrets(path: string = riotPaths.session): SessionSecrets | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const pick = (key: string) => {
    const v = scalar(raw, key);
    if (v) registerSecret(v);
    return v;
  };
  return {
    refreshToken: pick("refresh_token"),
    idToken: pick("id_token"),
    isDpopBound: /is_dpop_bound:\s*true/.test(raw),
  };
}

/**
 * Does this look like a session file that will actually sign someone in?
 *
 * Guards the restore path: writing a truncated or empty file over a live session logs the user
 * out with nothing to put back. A capture is refused rather than silently stored if it fails.
 */
export interface ValidationResult {
  valid: boolean;
  reasons: string[];
  summary: SessionSummary;
}

export function validateSessionFile(path: string): ValidationResult {
  const summary = summariseSession(path);
  const reasons: string[] = [];

  if (!summary.present) reasons.push("file does not exist");
  else {
    if (summary.bytes < 200) reasons.push(`file is only ${summary.bytes} bytes — too small to hold a token`);
    if (!summary.refreshToken) reasons.push("no refresh_token");
    else if (summary.refreshToken.length < 100) {
      reasons.push(`refresh_token is only ${summary.refreshToken.length} chars — implausibly short`);
    }
    if (summary.isDpopBound) {
      // Would mean the token is bound to this device and not portable — the assumption the
      // whole design rests on. Worth shouting about if Riot ever changes it.
      reasons.push("is_dpop_bound is true — this token is device-bound and will NOT transfer");
    }
    if (summary.daysUntilExpiry !== null && summary.daysUntilExpiry < 0) {
      reasons.push(`session expired ${Math.abs(summary.daysUntilExpiry)} days ago`);
    }
  }

  return { valid: reasons.length === 0, reasons, summary };
}

/** Copy the live session somewhere safe. Refuses to capture a file that would not sign in. */
export function captureSession(
  destination: string,
  { source = riotPaths.session, allowInvalid = false }: { source?: string; allowInvalid?: boolean } = {}
): SessionSummary {
  const validation = validateSessionFile(source);
  if (!validation.valid && !allowInvalid) {
    throw new Error(`refusing to capture an unusable session: ${validation.reasons.join("; ")}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  return validation.summary;
}

/**
 * Write a session into place, atomically.
 *
 * The caller is responsible for having stopped the client first and for having captured
 * whatever is being overwritten — `switchAccount` does both. This function enforces the one
 * thing it can see for itself: that the incoming content is a plausible session.
 */
export function restoreSessionFromString(
  content: string,
  { target = riotPaths.session, allowInvalid = false }: { target?: string; allowInvalid?: boolean } = {}
): SessionSummary {
  mkdirSync(dirname(target), { recursive: true });

  const temp = join(dirname(target), `.leagueswitcher-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(temp, content, "utf8");

  const validation = validateSessionFile(temp);
  if (!validation.valid && !allowInvalid) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw new Error(`refusing to restore an unusable session: ${validation.reasons.join("; ")}`);
  }

  // rename is atomic within a volume, so the target is never observed half-written.
  renameSync(temp, target);
  return summariseSession(target);
}

export function restoreSessionFromFile(
  sourceFile: string,
  options: { target?: string; allowInvalid?: boolean } = {}
): SessionSummary {
  if (!existsSync(sourceFile)) throw new Error(`no captured session at ${sourceFile}`);
  return restoreSessionFromString(readFileSync(sourceFile, "utf8"), options);
}

/** Raw contents. Callers must treat the result as secret. */
export function readSessionRaw(path: string = riotPaths.session): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * A structurally valid, signed-out session. Used to force the client to the login screen
 * for assisted enrolment (S4) without deleting anything.
 */
export const SIGNED_OUT_SESSION = ["psl:", "    authorization: null", "riot-login:", "    persist: null", ""].join("\n");

export interface SessionDiff {
  changed: boolean;
  refreshTokenRotated: boolean;
  idTokenRotated: boolean;
  tdidRotated: boolean;
  writeCountDelta: number | null;
  /** True when the file changed in a way worth re-capturing for. */
  shouldRecapture: boolean;
}

/**
 * Compare two summaries. EXP-5 found that a sign-in rotates `id_token` and bumps
 * `refresh_token_write_count` while `refresh_token` itself stays put — so "changed" is normal
 * after every switch, and `shouldRecapture` is a freshness signal rather than an alarm.
 */
export function diffSessions(before: SessionSummary, after: SessionSummary): SessionDiff {
  const refreshTokenRotated = before.refreshToken?.fingerprint !== after.refreshToken?.fingerprint;
  const idTokenRotated = before.idToken?.fingerprint !== after.idToken?.fingerprint;
  const tdidRotated = before.tdid?.fingerprint !== after.tdid?.fingerprint;
  const writeCountDelta =
    before.refreshTokenWriteCount !== null && after.refreshTokenWriteCount !== null
      ? after.refreshTokenWriteCount - before.refreshTokenWriteCount
      : null;

  return {
    changed: before.sha256 !== after.sha256,
    refreshTokenRotated,
    idTokenRotated,
    tdidRotated,
    writeCountDelta,
    shouldRecapture: before.sha256 !== after.sha256,
  };
}
