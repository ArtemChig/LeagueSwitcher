/**
 * Windows DPAPI encryption, scoped to the current user account.
 *
 * PLAN §2.1 nominates Electron's `safeStorage`, which is DPAPI underneath. This calls
 * `System.Security.Cryptography.ProtectedData` directly instead, for one reason: the Phase 1
 * engine and its CLI have to work headlessly, and `safeStorage` requires an Electron app
 * instance. One format used by both the CLI and the GUI beats two incompatible ones.
 *
 * Security properties are the same either way — the key is derived from the Windows user
 * account, so an encrypted vault copied to another machine, or opened by another user on this
 * machine, is unreadable. Nothing to manage, nothing to store.
 *
 * SECRET HANDLING: plaintext is passed over **stdin**, never as a command-line argument.
 * Process command lines are readable by any other process on the system, so an argument-passing
 * implementation would leak every password it encrypted to anything running `Get-Process`.
 */
import { spawn } from "node:child_process";

/**
 * The blob was read by DPAPI and rejected — wrong user, wrong machine, or genuinely damaged.
 * This is the only failure that means "the data is bad".
 */
export class DpapiRejectedError extends Error {
  readonly kind = "rejected" as const;
}

/**
 * DPAPI could not be *run*: powershell.exe would not start, exited oddly, or produced nothing.
 * Says nothing about the data. Treating this as corruption is how a transient hiccup turns
 * into permanent loss of the vault, so it is a distinct type and callers must not confuse it.
 */
export class DpapiUnavailableError extends Error {
  readonly kind = "unavailable" as const;
}

/** Extra entropy mixed into every operation, tying blobs to this application. */
const ENTROPY = "LeagueSwitcher.v1";

/**
 * Run the helper, retrying only failures that say nothing about the data.
 *
 * Spawning PowerShell can fail under load — which happens exactly when this app is busiest,
 * stopping and restarting the Riot client. One retry turns a lost vault read into a pause.
 */
async function runPowerShellWithRetry(script: string, stdin: string, attempts = 3): Promise<string> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await runPowerShell(script, stdin);
    } catch (err) {
      last = err;
      if (err instanceof DpapiRejectedError) throw err; // the data is bad; retrying cannot help
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
  throw last;
}

function runPowerShell(script: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));

    child.on("error", (err) => reject(new Error(`DPAPI: could not start powershell.exe — ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        // stderr from a DPAPI failure describes the failure, never the plaintext.
        reject(new Error(`DPAPI failed (exit ${code}): ${stderr.trim().split("\n")[0] ?? "no detail"}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.stdin.end(stdin, "utf8");
  });
}

const PROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($b64)
$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, 'CurrentUser')
[Convert]::ToBase64String($protected)
`.trim();

const UNPROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($b64)
$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, 'CurrentUser')
[Convert]::ToBase64String($plain)
`.trim();

/** Encrypt for the current Windows user. */
export async function protect(plaintext: string): Promise<Buffer> {
  const b64 = await runPowerShellWithRetry(PROTECT_SCRIPT, Buffer.from(plaintext, "utf8").toString("base64"));
  if (!b64) throw new DpapiUnavailableError("encryption produced no output");
  return Buffer.from(b64, "base64");
}

/** Decrypt. Throws if the blob belongs to another user or machine, or has been tampered with. */
export async function unprotect(ciphertext: Buffer): Promise<string> {
  const b64 = await runPowerShellWithRetry(UNPROTECT_SCRIPT, ciphertext.toString("base64"));
  if (!b64) throw new DpapiUnavailableError("decryption produced no output");
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Is DPAPI usable here? Called at startup so failure surfaces before anything is stored. */
export async function isAvailable(): Promise<boolean> {
  try {
    const probe = "leagueswitcher-dpapi-selftest";
    return (await unprotect(await protect(probe))) === probe;
  } catch {
    return false;
  }
}
