/**
 * Regression: a vault that cannot be READ right now must not be treated as DESTROYED.
 *
 * Decryption shells out to powershell.exe. Spawning it can fail under load — which is exactly
 * when this app is busiest, stopping and restarting the Riot client. The vault used to catch
 * any failure, wipe its in-memory contents, and rename secrets.enc out of the way as corrupt.
 *
 * Observed: "No Riot API key is configured" moments after enrolling an account, from a vault
 * that was completely intact. The key survived only because the rename failed — the file was
 * in use. Had it succeeded, a transient hiccup would have permanently destroyed the API key
 * and every stored password, with no way back.
 *
 * The rule: only a cryptographic rejection is evidence that the data is bad. Everything else
 * leaves the file exactly where it is.
 *
 * DPAPI is mocked here — the point is the vault's reaction to each failure mode, not the
 * encryption itself, which tests/vault.test.ts exercises for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const behaviour = {
  mode: "ok" as "ok" | "unavailable" | "rejected",
  attempts: 0,
};

vi.mock("../src/main/store/dpapi.js", async () => {
  const actual = await vi.importActual<typeof import("../src/main/store/dpapi.js")>(
    "../src/main/store/dpapi.js"
  );
  return {
    ...actual,
    dpapiAvailable: async () => true,
    protect: async (plain: string) => Buffer.from(plain, "utf8"),
    unprotect: async (buf: Buffer) => {
      behaviour.attempts++;
      if (behaviour.mode === "unavailable") {
        throw new actual.DpapiUnavailableError("could not start powershell.exe");
      }
      if (behaviour.mode === "rejected") {
        throw new actual.DpapiRejectedError("decryption refused: CryptographicException");
      }
      return buf.toString("utf8");
    },
  };
});

const { Vault } = await import("../src/main/store/vault.js");

const API_KEY = ["RGAPI", "11111111-2222-3333-4444-555555555555"].join("-");

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ls-vault-res-"));
  previous = process.env.LEAGUESWITCHER_DATA_DIR;
  process.env.LEAGUESWITCHER_DATA_DIR = dir;
  behaviour.mode = "ok";
  behaviour.attempts = 0;
});

afterEach(() => {
  if (previous === undefined) delete process.env.LEAGUESWITCHER_DATA_DIR;
  else process.env.LEAGUESWITCHER_DATA_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

const asideFiles = () => readdirSync(dir).filter((f) => f.includes("corrupt"));

async function seedVault(): Promise<void> {
  const v = new Vault();
  await v.load();
  await v.setApiKey(API_KEY);
  expect(existsSync(join(dir, "secrets.enc"))).toBe(true);
}

describe("a vault that cannot be read right now", () => {
  it("does not move secrets.enc aside when DPAPI could not be run", async () => {
    await seedVault();

    behaviour.mode = "unavailable";
    const v = new Vault();
    await v.load();

    expect(existsSync(join(dir, "secrets.enc"))).toBe(true);
    expect(asideFiles()).toEqual([]);
  });

  it("reports the failure as temporary, not as corruption", async () => {
    await seedVault();

    behaviour.mode = "unavailable";
    const v = new Vault();
    await v.load();

    expect(v.warnings.map((w) => w.kind)).toContain("unavailable");
    expect(v.warnings.map((w) => w.kind)).not.toContain("corrupt");
  });

  it("recovers the key once DPAPI works again", async () => {
    await seedVault();

    behaviour.mode = "unavailable";
    const v = new Vault();
    await v.load();
    expect(v.getApiKey()).toBeNull();

    // Nothing was destroyed, so a later read on the same instance must succeed.
    behaviour.mode = "ok";
    await v.load();
    expect(v.getApiKey()).toBe(API_KEY);
  });

  // The retry itself lives inside dpapi.ts, below the seam these tests mock, so it cannot be
  // observed from here — a test at this layer would only be asserting the mock. What matters
  // to the vault is covered above: a transient failure changes nothing on disk and does not
  // poison the cache, so the next read succeeds whether it retried or not.
});

describe("a vault that really is corrupt", () => {
  it("still sets the file aside when DPAPI rejects the blob", async () => {
    await seedVault();

    behaviour.mode = "rejected";
    const v = new Vault();
    await v.load();

    expect(v.warnings.map((w) => w.kind)).toContain("corrupt");
    expect(asideFiles().length).toBe(1);
  });

  it("does not retry a rejection, because retrying cannot help", async () => {
    await seedVault();

    behaviour.mode = "rejected";
    behaviour.attempts = 0;
    const v = new Vault();
    await v.load();

    expect(behaviour.attempts).toBe(1);
  });
});
