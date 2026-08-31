/**
 * Regression: the account store must not clobber concurrent writes.
 *
 * The bug this pins down was silent and destructive. `load()` cached after the first read and
 * never re-read, while `save()` wrote the entire in-memory snapshot back. So any process that
 * had loaded the store held a frozen copy, and its next save erased whatever another process
 * had written since.
 *
 * Assisted enrolment hit it every time: the CLI loads the store, then waits minutes for the
 * user to sign in and clear the captcha, then saves. Anything written in that window was lost.
 * The observed symptom was an enrolment that reported success and really did store the session
 * and password in the vault — while leaving no account in accounts.json at all. Nothing errored,
 * so nothing pointed at the store.
 *
 * These tests drive two store instances over one file, which is what two processes look like
 * from the file's point of view.
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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
  dir = mkdtempSync(join(tmpdir(), "ls-accounts-"));
  accountsPath = join(dir, "accounts.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = () => JSON.parse(readFileSync(accountsPath, "utf8"));

describe("concurrent writers", () => {
  it("does not erase an account added by another process", () => {
    const a = new AccountStore();
    a.upsert(createAccount("thunder", "accountOne"));
    expect(read().accounts).toHaveLength(1);

    // A second process enrols someone else while the first store is still alive.
    const b = new AccountStore();
    b.upsert(createAccount("demon", "accountFour"));
    expect(read().accounts).toHaveLength(2);

    // The first store now writes again. Before the fix its stale snapshot won and "demon"
    // vanished — exactly the enrolment failure.
    a.setActive("thunder");

    const ids = read().accounts.map((x: { id: string }) => x.id).sort();
    expect(ids).toEqual(["demon", "thunder"]);
  });

  it("sees a foreign update rather than serving a cached copy", () => {
    const a = new AccountStore();
    a.upsert(createAccount("demon", "accountFour", { summonerLevel: 1 }));
    expect(a.get("demon")?.summonerLevel).toBe(1);

    const b = new AccountStore();
    b.update("demon", { summonerLevel: 48 });

    expect(a.get("demon")?.summonerLevel).toBe(48);
  });

  it("keeps a foreign account when updating a different one", () => {
    const a = new AccountStore();
    a.upsert(createAccount("thunder", "accountOne"));

    const b = new AccountStore();
    b.upsert(createAccount("demon", "accountFour"));

    a.update("thunder", { label: "Main" });

    const after = read().accounts;
    expect(after).toHaveLength(2);
    expect(after.find((x: { id: string }) => x.id === "thunder").label).toBe("Main");
  });

  it("survives the file being replaced wholesale underneath it", () => {
    const a = new AccountStore();
    a.upsert(createAccount("thunder", "accountOne"));

    const replacement = {
      version: 1,
      accounts: [createAccount("accounttwo", "accountTwo")],
      activeAccountId: "accounttwo",
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    };
    writeFileSync(accountsPath, JSON.stringify(replacement, null, 2), "utf8");

    expect(a.list().map((x) => x.id)).toEqual(["accounttwo"]);
    expect(a.getActiveId()).toBe("accounttwo");
  });
});

describe("single writer still behaves", () => {
  it("persists an upsert, an update and the active id", () => {
    const s = new AccountStore();
    s.upsert(createAccount("demon", "accountFour"));
    s.update("demon", { gameName: "SUMMONER TWO", tagLine: "IDF", summonerLevel: 48 });
    s.setActive("demon");

    const onDisk = read();
    expect(onDisk.activeAccountId).toBe("demon");
    expect(onDisk.accounts[0].gameName).toBe("SUMMONER TWO");
    expect(onDisk.accounts[0].summonerLevel).toBe(48);
  });

  it("reports nothing when the file does not exist yet", () => {
    expect(new AccountStore().list()).toEqual([]);
  });
});
