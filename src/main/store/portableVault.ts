/**
 * P4.5 — encrypted export and import, for moving a vault between machines.
 *
 * The everyday vault is DPAPI-encrypted, which is exactly what you want on one machine and
 * useless for portability: a DPAPI blob is bound to the Windows user account that created it,
 * so copying `secrets.enc` to another PC produces a file nobody can open. That is the point of
 * DPAPI, not a flaw in it — but it means export needs its own scheme.
 *
 * So an export is AES-256-GCM under a key derived from a user passphrase with scrypt:
 *
 *   - scrypt (N=2^15) makes a weak passphrase expensive to attack, unlike a bare hash.
 *   - A random 16-byte salt per export means two exports of the same vault with the same
 *     passphrase do not produce the same key.
 *   - GCM authenticates as well as encrypts, so a corrupted or tampered file fails loudly
 *     instead of decrypting into garbage that then overwrites a working vault.
 *
 * The file carries a version and a plaintext header so a future format can be recognised
 * rather than guessed at.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import type { Vault, StoredCredential } from "./vault.js";

export const EXPORT_FORMAT = "LEAGUESWITCHER-VAULT";
export const EXPORT_VERSION = 1;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const SCRYPT_COST = 32768; // 2^15

export interface ExportPayload {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  apiKey: string | null;
  credentials: Record<string, StoredCredential>;
  /** accountId -> the account's session YAML. */
  sessions: Record<string, string>;
}

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  // scryptSync's default maxmem is too small for N=2^15, so it is raised explicitly.
  return new Promise((resolve, reject) => {
    scryptCb(passphrase, salt, KEY_BYTES, { N: SCRYPT_COST, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * Package the whole vault into one encrypted buffer.
 *
 * File layout, all binary after the header line:
 *   "LEAGUESWITCHER-VAULT v1\n" | salt(16) | iv(12) | authTag(16) | ciphertext
 */
export async function exportVault(
  vault: Vault,
  passphrase: string,
  { includeSessions = true }: { includeSessions?: boolean } = {}
): Promise<Buffer> {
  if (!passphrase || passphrase.length < 8) {
    throw new Error("Choose a passphrase of at least 8 characters — this file holds every password.");
  }

  const sessions: Record<string, string> = {};
  if (includeSessions) {
    for (const id of vault.listSessionAccountIds()) {
      const yaml = await vault.getSession(id);
      if (yaml) sessions[id] = yaml;
    }
  }

  const credentials: Record<string, StoredCredential> = {};
  for (const id of vault.listCredentialAccountIds()) {
    const cred = vault.getCredential(id);
    if (cred) credentials[id] = cred;
  }

  const payload: ExportPayload = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    apiKey: vault.getApiKey(),
    credentials,
    sessions,
  };

  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([Buffer.from(`${EXPORT_FORMAT} v${EXPORT_VERSION}\n`, "utf8"), salt, iv, authTag, ciphertext]);
}

export interface ImportResult {
  credentialsImported: number;
  sessionsImported: number;
  apiKeyImported: boolean;
  skipped: string[];
  exportedAt: string;
}

/**
 * Restore an exported vault.
 *
 * Defaults to NOT overwriting anything that already exists: an import is usually "add my other
 * machine's accounts", and silently replacing a working session with an older one is the kind
 * of data loss that is only noticed when a switch fails. Pass `overwrite` to replace.
 */
export async function importVault(
  vault: Vault,
  data: Buffer,
  passphrase: string,
  { overwrite = false }: { overwrite?: boolean } = {}
): Promise<ImportResult> {
  const newlineIndex = data.indexOf(0x0a);
  if (newlineIndex < 0) throw new Error("This is not a LeagueSwitcher vault export.");

  const header = data.subarray(0, newlineIndex).toString("utf8").trim();
  const [format, version] = header.split(/\s+/);
  if (format !== EXPORT_FORMAT) throw new Error("This is not a LeagueSwitcher vault export.");
  if (version !== `v${EXPORT_VERSION}`) {
    throw new Error(`Unsupported export version ${version ?? "?"} — this build reads v${EXPORT_VERSION}.`);
  }

  let offset = newlineIndex + 1;
  const salt = data.subarray(offset, (offset += SALT_BYTES));
  const iv = data.subarray(offset, (offset += IV_BYTES));
  const authTag = data.subarray(offset, (offset += 16));
  const ciphertext = data.subarray(offset);

  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || authTag.length !== 16 || ciphertext.length === 0) {
    throw new Error("This export file is truncated or corrupt.");
  }

  const key = await deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let json: string;
  try {
    json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // GCM authentication covers both causes, and they are indistinguishable by design.
    throw new Error("Wrong passphrase, or the file has been altered.");
  }

  const payload = JSON.parse(json) as ExportPayload;
  const result: ImportResult = {
    credentialsImported: 0,
    sessionsImported: 0,
    apiKeyImported: false,
    skipped: [],
    exportedAt: payload.exportedAt,
  };

  if (payload.apiKey && (overwrite || !vault.getApiKey())) {
    await vault.setApiKey(payload.apiKey);
    result.apiKeyImported = true;
  }

  for (const [id, cred] of Object.entries(payload.credentials ?? {})) {
    if (!overwrite && vault.hasCredential(id)) {
      result.skipped.push(`credential:${id}`);
      continue;
    }
    await vault.setCredential(id, cred.username, cred.password);
    result.credentialsImported++;
  }

  for (const [id, yaml] of Object.entries(payload.sessions ?? {})) {
    if (!overwrite && vault.hasSession(id)) {
      result.skipped.push(`session:${id}`);
      continue;
    }
    await vault.putSession(id, yaml);
    result.sessionsImported++;
  }

  return result;
}

/** Cheap check for the UI, so a wrong file is caught before a passphrase is asked for. */
export function looksLikeVaultExport(data: Buffer): boolean {
  const header = Buffer.from(EXPORT_FORMAT, "utf8");
  return data.length > header.length && timingSafeEqual(data.subarray(0, header.length), header);
}
