/**
 * Regression: concurrent readers must never see a half-loaded vault.
 *
 * The app showed "No Riot API key" over a vault that demonstrably had one, intermittently,
 * with no error and no warning. The CLI never reproduced it.
 *
 * Two races, both invisible because the result was a *valid-looking* empty vault:
 *
 *   1. getVault() assigned the singleton BEFORE awaiting its load. A second caller arriving
 *      during that await got the instance with empty contents and returned it as ready.
 *   2. load() set `loaded = true` before awaiting decryption, so even a direct second load()
 *      sailed past the guard and returned while contents were still empty.
 *
 * The app calls getVault() three times at launch — collect, adopt, refresh — so it hit this
 * often. The CLI is sequential, which is why it always looked fine there.
 *
 * Decryption is slowed deliberately here: the race needs a real await gap to open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let decryptDelayMs = 0;
let decryptCalls = 0;

vi.mock("../src/main/store/dpapi.js", async () => {
  const actual = await vi.importActual<typeof import("../src/main/store/dpapi.js")>(
    "../src/main/store/dpapi.js"
  );
  return {
    ...actual,
    dpapiAvailable: async () => true,
    protect: async (plain: string) => Buffer.from(plain, "utf8"),
    unprotect: async (buf: Buffer) => {
      decryptCalls++;
      if (decryptDelayMs) await new Promise((r) => setTimeout(r, decryptDelayMs));
      return buf.toString("utf8");
    },
  };
});

const { Vault, getVault, resetVaultForTests } = await import("../src/main/store/vault.js");

const API_KEY = ["RGAPI", "11111111-2222-3333-4444-555555555555"].join("-");

let dir: string;
let previous: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ls-vault-conc-"));
  previous = process.env.LEAGUESWITCHER_DATA_DIR;
  process.env.LEAGUESWITCHER_DATA_DIR = dir;
  decryptDelayMs = 0;
  decryptCalls = 0;
  resetVaultForTests();

  const seed = new Vault();
  await seed.load();
  await seed.setApiKey(API_KEY);
  resetVaultForTests();
});

afterEach(() => {
  if (previous === undefined) delete process.env.LEAGUESWITCHER_DATA_DIR;
  else process.env.LEAGUESWITCHER_DATA_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
  resetVaultForTests();
});

describe("concurrent getVault()", () => {
  it("gives every caller a fully loaded vault", async () => {
    decryptDelayMs = 40;

    // Exactly what app launch does: collect, adopt and refresh all ask at once.
    //
    // The key must be read AT THE MOMENT each caller is handed the vault. Reading after
    // Promise.all cannot see the bug: every caller holds the same object, so the first
    // caller's load has populated it by then. That is precisely why this was invisible.
    const seen = await Promise.all([
      getVault().then((v) => v.getApiKey()),
      getVault().then((v) => v.getApiKey()),
      getVault().then((v) => v.getApiKey()),
    ]);

    expect(seen).toEqual([API_KEY, API_KEY, API_KEY]);
  });

  it("decrypts once for a burst of callers rather than racing", async () => {
    decryptDelayMs = 40;
    decryptCalls = 0;

    await Promise.all([getVault(), getVault(), getVault(), getVault()]);

    expect(decryptCalls).toBe(1);
  });

  it("holds under a staggered burst, not just a simultaneous one", async () => {
    decryptDelayMs = 30;

    const seen = await Promise.all([
      getVault().then((v) => v.getApiKey()),
      new Promise((r) => setTimeout(r, 5)).then(() => getVault().then((v) => v.getApiKey())),
      new Promise((r) => setTimeout(r, 15)).then(() => getVault().then((v) => v.getApiKey())),
      new Promise((r) => setTimeout(r, 25)).then(() => getVault().then((v) => v.getApiKey())),
    ]);

    expect(seen).toEqual([API_KEY, API_KEY, API_KEY, API_KEY]);
  });
});

describe("concurrent load() on one instance", () => {
  it("does not return before the first load has finished", async () => {
    decryptDelayMs = 40;
    const v = new Vault();

    const seen = await Promise.all([
      v.load().then(() => v.getApiKey()),
      v.load().then(() => v.getApiKey()),
      v.load().then(() => v.getApiKey()),
    ]);

    expect(seen).toEqual([API_KEY, API_KEY, API_KEY]);
  });
});
