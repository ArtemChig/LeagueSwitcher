/**
 * Regression: a transient missing-file reading must not empty a store permanently.
 *
 * Reported as "after the app is open a while all the accounts randomly disappear, and reopening
 * loads them back". The cause was a single line that was not there:
 *
 *   if (!existsSync(path)) { this.loaded = true; this.data = EMPTY; return; }   // stamp kept
 *
 * One blip — Windows can report a file as briefly absent while it is being replaced, and the
 * store renames over that exact path on every save — emptied the in-memory data while leaving
 * `stamp` holding the file's mtime. The staleness check then matched on every later call and
 * short-circuited, so the store served nothing for the life of the process.
 *
 * It compounded: `update()` returned null when it found no account, silently, so switches and
 * refreshes became no-ops. accounts.json was never rewritten, its mtime never changed, and the
 * store could never notice it was wrong. On disk everything was intact, which is why relaunching
 * fixed it — and why the file had not been modified in two days despite daily use.
 *
 * The same shape existed in the vault, where it showed as "no password stored" for every
 * account while switching kept working.
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let accountsPath: string;

vi.mock("../src/main/riot/paths.js", () => ({
  appPaths: {
    get root() { return dir; },
    get accounts() { return accountsPath; },
    get backups() { return join(dir, "backups"); },
  },
  riotPaths: {},
}));

const { AccountStore, createAccount } = await import("../src/main/store/accounts.js");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ls-recover-"));
  accountsPath = join(dir, "accounts.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Hide the file for exactly one existsSync, the way a rename-in-progress does. */
function blipFileAway(): void {
  const hidden = accountsPath + ".hidden";
  renameSync(accountsPath, hidden);
  renameSync(hidden, accountsPath);
}

function seed(store: InstanceType<typeof AccountStore>, n = 11): void {
  for (let i = 0; i < n; i++) store.upsert(createAccount(`acct${i}`, `login${i}`));
}

describe("a store that briefly cannot see its file", () => {
  it("does not serve an empty list once the file is back", () => {
    const s = new AccountStore();
    seed(s);
    expect(s.list()).toHaveLength(11);

    // Simulate the branch firing: empty data, stamp left pointing at the unchanged file.
    const hidden = accountsPath + ".hidden";
    renameSync(accountsPath, hidden);
    s.load();                 // sees the file missing
    renameSync(hidden, accountsPath); // ...and it is immediately back, mtime unchanged

    expect(s.list()).toHaveLength(11);
  });

  it("keeps accepting writes after a blip, so nothing silently no-ops", () => {
    const s = new AccountStore();
    seed(s);

    const hidden = accountsPath + ".hidden";
    renameSync(accountsPath, hidden);
    s.load();
    renameSync(hidden, accountsPath);

    // This is the write that was being dropped: a switch recording lastSwitchedAt.
    const updated = s.update("acct3", { lastSwitchedAt: "2026-09-02T00:00:00.000Z" });
    expect(updated).not.toBeNull();

    const onDisk = JSON.parse(readFileSync(accountsPath, "utf8"));
    expect(onDisk.accounts).toHaveLength(11);
    expect(onDisk.accounts.find((a: { id: string }) => a.id === "acct3").lastSwitchedAt)
      .toBe("2026-09-02T00:00:00.000Z");
  });

  it("survives repeated blips rather than degrading over time", () => {
    const s = new AccountStore();
    seed(s);

    for (let i = 0; i < 20; i++) {
      blipFileAway();
      s.load();
      expect(s.list(), `after blip ${i + 1}`).toHaveLength(11);
    }
  });

  it("records a warning when an update finds no such account", () => {
    const s = new AccountStore();
    seed(s, 2);
    expect(s.update("does-not-exist", { label: "x" })).toBeNull();
    expect(s.warnings.join(" ")).toMatch(/does-not-exist/);
  });
});

describe("a store whose file genuinely does not exist", () => {
  it("reports an empty list without inventing anything", () => {
    expect(new AccountStore().list()).toEqual([]);
    expect(existsSync(accountsPath)).toBe(false);
  });

  it("picks the file up once it appears", () => {
    const s = new AccountStore();
    expect(s.list()).toEqual([]);

    writeFileSync(
      accountsPath,
      JSON.stringify({
        version: 1,
        accounts: [createAccount("later", "later")],
        activeAccountId: null,
        updatedAt: new Date().toISOString(),
      }),
      "utf8"
    );

    expect(s.list().map((a) => a.id)).toEqual(["later"]);
  });
});
