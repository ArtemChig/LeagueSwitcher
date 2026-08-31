/**
 * P4.6 — the vault, and P4.5's portable export.
 *
 * These tests hit real DPAPI, so they are slower than the rest of the suite. That is the point:
 * mocking the encryption would leave the one thing worth proving — that secrets survive a
 * round-trip and never appear in plaintext on disk — untested.
 *
 * Each test gets its own data directory via LEAGUESWITCHER_DATA_DIR, so nothing touches the
 * real vault in %APPDATA%.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault, accountIdFromUsername } from "../src/main/store/vault.js";
import { exportVault, importVault, looksLikeVaultExport } from "../src/main/store/portableVault.js";

const PASSWORD = "correct-horse-battery-staple-42";
const API_KEY = ["RGAPI", "11111111-2222-3333-4444-555555555555"].join("-");
const SESSION_YAML = "psl:\n  authorization:\n    riot-client:\n      refresh_token: " + "z".repeat(1333) + "\n";

let dir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ls-vault-"));
  previousDataDir = process.env.LEAGUESWITCHER_DATA_DIR;
  process.env.LEAGUESWITCHER_DATA_DIR = dir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.LEAGUESWITCHER_DATA_DIR;
  else process.env.LEAGUESWITCHER_DATA_DIR = previousDataDir;
  rmSync(dir, { recursive: true, force: true });
});

async function freshVault(): Promise<Vault> {
  const vault = new Vault();
  await vault.load();
  return vault;
}

describe("credentials round-trip through DPAPI", () => {
  it("stores and returns a password", async () => {
    const vault = await freshVault();
    await vault.setCredential("acct", "SomeUser", PASSWORD);
    expect(vault.getCredential("acct")?.password).toBe(PASSWORD);
  });

  it("survives a reload from disk", async () => {
    const first = await freshVault();
    await first.setCredential("acct", "SomeUser", PASSWORD);
    await first.setApiKey(API_KEY);

    const second = await freshVault();
    expect(second.getCredential("acct")?.password).toBe(PASSWORD);
    expect(second.getApiKey()).toBe(API_KEY);
  });

  it("writes NOTHING readable to disk", async () => {
    const vault = await freshVault();
    await vault.setCredential("acct", "SomeUser", PASSWORD);
    await vault.setApiKey(API_KEY);

    // The whole point of the vault: grep the bytes and find no secret.
    const raw = readFileSync(join(dir, "secrets.enc"));
    const asText = raw.toString("latin1");
    expect(asText).not.toContain(PASSWORD);
    expect(asText).not.toContain(API_KEY);
    expect(asText).not.toContain("SomeUser");
  });

  it("handles a password full of characters that break naive shell quoting", async () => {
    // The DPAPI helper shells out to PowerShell, so this is not a hypothetical.
    const nasty = `p"a's$w\`o|r&d;#{}\n\ttab-and-newline-€—`;
    const vault = await freshVault();
    await vault.setCredential("acct", "user", nasty);
    expect((await freshVault()).getCredential("acct")?.password).toBe(nasty);
  });

  it("deletes a credential", async () => {
    const vault = await freshVault();
    await vault.setCredential("acct", "user", PASSWORD);
    await vault.deleteCredential("acct");
    expect(vault.getCredential("acct")).toBeNull();
    expect((await freshVault()).hasCredential("acct")).toBe(false);
  });
});

describe("sessions", () => {
  it("stores a session encrypted and reads it back byte-for-byte", async () => {
    const vault = await freshVault();
    await vault.putSession("acct", SESSION_YAML);

    expect(await vault.getSession("acct")).toBe(SESSION_YAML);
    const onDisk = readFileSync(join(dir, "sessions", "acct.enc")).toString("latin1");
    expect(onDisk).not.toContain("refresh_token");
  });

  it("returns null for an account with no session", async () => {
    expect(await (await freshVault()).getSession("nobody")).toBeNull();
  });

  it("records a warning instead of throwing when a session will not decrypt", async () => {
    const vault = await freshVault();
    await vault.putSession("acct", SESSION_YAML);
    // Simulate a blob from another Windows user, which is the realistic cause.
    writeFileSync(join(dir, "sessions", "acct.enc"), Buffer.from("not a dpapi blob at all"));

    expect(await vault.getSession("acct")).toBeNull();
    expect(vault.warnings.some((w) => w.kind === "unreadable-session")).toBe(true);
  });

  it("forgets everything for one account", async () => {
    const vault = await freshVault();
    await vault.setCredential("acct", "user", PASSWORD);
    await vault.putSession("acct", SESSION_YAML);
    await vault.forget("acct");
    expect(vault.hasCredential("acct")).toBe(false);
    expect(vault.hasSession("acct")).toBe(false);
  });
});

describe("corruption is preserved, not destroyed", () => {
  it("sets aside an undecryptable vault and carries on empty", async () => {
    const first = await freshVault();
    await first.setCredential("acct", "user", PASSWORD);

    writeFileSync(join(dir, "secrets.enc"), Buffer.from("corrupted beyond recovery"));

    const second = await freshVault();
    expect(second.warnings.some((w) => w.kind === "corrupt")).toBe(true);
    expect(second.listCredentialAccountIds()).toEqual([]);

    // Set aside, not deleted: this usually means "different Windows user", which is recoverable.
    expect(readdirSync(dir).some((f) => f.startsWith("secrets.enc.corrupt-"))).toBe(true);
  });
});

describe("legacy plaintext migration (PLAN §7 rule 8)", () => {
  it("imports the API key file and then deletes it", async () => {
    writeFileSync(join(dir, "riot-api-key.txt"), API_KEY + "\n", "utf8");

    const vault = await freshVault();
    expect(vault.getApiKey()).toBe(API_KEY);
    expect(existsSync(join(dir, "riot-api-key.txt"))).toBe(false);
    expect(vault.warnings.some((w) => w.kind === "migrated")).toBe(true);
  });

  it("imports credentials from an array-shaped file and deletes it", async () => {
    writeFileSync(
      join(dir, "test-credentials.json"),
      JSON.stringify([
        { username: "AccountOne", password: "pw-one" },
        { username: "AccountTwo", password: "pw-two" },
      ]),
      "utf8"
    );

    const vault = await freshVault();
    expect(vault.listCredentialAccountIds().sort()).toEqual(["accountone", "accounttwo"]);
    expect(vault.getCredential("accountone")?.password).toBe("pw-one");
    expect(existsSync(join(dir, "test-credentials.json"))).toBe(false);
  });

  it("also accepts an object keyed by username", async () => {
    writeFileSync(join(dir, "test-credentials.json"), JSON.stringify({ SomeUser: { password: "pw" } }), "utf8");
    const vault = await freshVault();
    expect(vault.getCredential("someuser")?.password).toBe("pw");
  });

  it("leaves an unparseable file in place rather than losing it", async () => {
    writeFileSync(join(dir, "test-credentials.json"), "{ not json", "utf8");
    const vault = await freshVault();
    expect(existsSync(join(dir, "test-credentials.json"))).toBe(true);
    expect(vault.warnings.some((w) => w.message.includes("Could not migrate"))).toBe(true);
  });
});

describe("account ids", () => {
  it("is stable and case-insensitive, so one account cannot become two", () => {
    expect(accountIdFromUsername("accountOne")).toBe("accountone");
    expect(accountIdFromUsername("  ACCOUNTONE  ")).toBe("accountone");
    expect(accountIdFromUsername("some.user_name")).toBe("some-user-name");
  });
});

describe("portable export (P4.5)", () => {
  const PASSPHRASE = "a-strong-export-passphrase";

  async function populated(): Promise<Vault> {
    const vault = await freshVault();
    await vault.setApiKey(API_KEY);
    await vault.setCredential("acct", "SomeUser", PASSWORD);
    await vault.putSession("acct", SESSION_YAML);
    return vault;
  }

  it("round-trips into a fresh vault", async () => {
    const blob = await exportVault(await populated(), PASSPHRASE);

    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "ls-vault-"));
    process.env.LEAGUESWITCHER_DATA_DIR = dir;

    const target = await freshVault();
    const result = await importVault(target, blob, PASSPHRASE);

    expect(result.credentialsImported).toBe(1);
    expect(result.sessionsImported).toBe(1);
    expect(result.apiKeyImported).toBe(true);
    expect(target.getCredential("acct")?.password).toBe(PASSWORD);
    expect(await target.getSession("acct")).toBe(SESSION_YAML);
  });

  it("rejects the wrong passphrase without revealing anything", async () => {
    const blob = await exportVault(await populated(), PASSPHRASE);
    const target = await freshVault();
    await expect(importVault(target, blob, "not-the-passphrase")).rejects.toThrow(/Wrong passphrase/);
  });

  it("detects tampering, because GCM authenticates as well as encrypts", async () => {
    const blob = await exportVault(await populated(), PASSPHRASE);
    const at = blob.length - 5;
    blob.writeUInt8(blob.readUInt8(at) ^ 0xff, at);
    await expect(importVault(await freshVault(), blob, PASSPHRASE)).rejects.toThrow(/Wrong passphrase|altered/);
  });

  it("does not overwrite existing entries by default", async () => {
    const blob = await exportVault(await populated(), PASSPHRASE);
    const vault = await freshVault();
    await vault.setCredential("acct", "SomeUser", "the-newer-password");

    const result = await importVault(vault, blob, PASSPHRASE);
    expect(result.skipped).toContain("credential:acct");
    expect(vault.getCredential("acct")?.password).toBe("the-newer-password");
  });

  it("overwrites when asked", async () => {
    const blob = await exportVault(await populated(), PASSPHRASE);
    const vault = await freshVault();
    await vault.setCredential("acct", "SomeUser", "the-newer-password");

    await importVault(vault, blob, PASSPHRASE, { overwrite: true });
    expect(vault.getCredential("acct")?.password).toBe(PASSWORD);
  });

  it("produces different bytes each time, even for identical input", async () => {
    const vault = await populated();
    const a = await exportVault(vault, PASSPHRASE);
    const b = await exportVault(vault, PASSPHRASE);
    expect(a.equals(b)).toBe(false); // random salt and IV per export
  });

  it("refuses a weak passphrase", async () => {
    await expect(exportVault(await populated(), "short")).rejects.toThrow(/at least 8/);
  });

  it("recognises its own files and rejects others", async () => {
    const blob = await exportVault(await populated(), PASSPHRASE);
    expect(looksLikeVaultExport(blob)).toBe(true);
    expect(looksLikeVaultExport(Buffer.from("just some other file entirely"))).toBe(false);
  });

  it("carries no plaintext secret in the exported bytes", async () => {
    const blob = await exportVault(await populated(), PASSPHRASE);
    const text = blob.toString("latin1");
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain("refresh_token");
  });
});
