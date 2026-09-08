/**
 * Finding Riot's install on a machine that is not the developer's.
 *
 * The app assumed `C:\Riot Games` and offered only an environment variable as an escape hatch.
 * That works on exactly one machine and fails for anyone who put League on a second drive —
 * common, because the install is tens of gigabytes. Riot records the real location itself, so
 * these tests drive the discovery against manifests that point somewhere other than C:.
 *
 * Riot writes forward slashes in that manifest, and every case here keeps them, because
 * normalising them is the step most likely to be dropped in a refactor.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverRiotInstall, resetRiotInstallCache } from "../src/main/riot/discover.js";

let programData: string;
let fakeInstall: string;
let prevProgramData: string | undefined;
let prevOverride: string | undefined;

/** Build a plausible Riot install somewhere that is not C:\Riot Games. */
function makeInstall(root: string): void {
  mkdirSync(join(root, "Riot Client"), { recursive: true });
  mkdirSync(join(root, "League of Legends"), { recursive: true });
  writeFileSync(join(root, "Riot Client", "RiotClientServices.exe"), "");
}

function writeInstallsManifest(contents: unknown): void {
  const dir = join(programData, "Riot Games");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "RiotClientInstalls.json"), JSON.stringify(contents, null, 2), "utf8");
}

function writeProductMetadata(fullPath: string, root: string): void {
  const dir = join(programData, "Riot Games", "Metadata", "league_of_legends.live");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "league_of_legends.live.product_settings.yaml"),
    `product_install_full_path: "${fullPath}"\nproduct_install_root: "${root}"\n`,
    "utf8"
  );
}

/** Riot writes forward slashes; the manifest values must survive that. */
const fwd = (p: string) => p.replace(/\\/g, "/");

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "ls-discover-"));
  programData = join(base, "ProgramData");
  fakeInstall = join(base, "SecondDrive", "Riot Games");
  mkdirSync(programData, { recursive: true });
  makeInstall(fakeInstall);

  prevProgramData = process.env.PROGRAMDATA;
  prevOverride = process.env.LEAGUESWITCHER_RIOT_ROOT;
  process.env.PROGRAMDATA = programData;
  delete process.env.LEAGUESWITCHER_RIOT_ROOT;
  resetRiotInstallCache();
});

afterEach(() => {
  if (prevProgramData === undefined) delete process.env.PROGRAMDATA;
  else process.env.PROGRAMDATA = prevProgramData;
  if (prevOverride === undefined) delete process.env.LEAGUESWITCHER_RIOT_ROOT;
  else process.env.LEAGUESWITCHER_RIOT_ROOT = prevOverride;
  resetRiotInstallCache();
  rmSync(join(programData, ".."), { recursive: true, force: true });
});

describe("installs manifest", () => {
  it("finds an install on another drive from associated_client", () => {
    writeInstallsManifest({
      associated_client: {
        [`${fwd(join(fakeInstall, "League of Legends"))}/`]:
          fwd(join(fakeInstall, "Riot Client", "RiotClientServices.exe")),
      },
      rc_default: fwd(join(fakeInstall, "Riot Client", "RiotClientServices.exe")),
    });

    const found = discoverRiotInstall();
    expect(found.source).toBe("installs-manifest");
    expect(found.rcServices).toBe(join(fakeInstall, "Riot Client", "RiotClientServices.exe"));
    expect(found.leagueDir).toBe(join(fakeInstall, "League of Legends"));
  });

  it("falls back to rc_live when there is no association", () => {
    writeInstallsManifest({
      rc_live: fwd(join(fakeInstall, "Riot Client", "RiotClientServices.exe")),
    });

    const found = discoverRiotInstall();
    expect(found.source).toBe("installs-manifest");
    expect(found.leagueDir).toBe(join(fakeInstall, "League of Legends"));
  });

  it("ignores a stale entry pointing at a drive that is gone", () => {
    writeInstallsManifest({
      associated_client: { "Z:/Riot Games/League of Legends/": "Z:/Riot Games/Riot Client/RiotClientServices.exe" },
    });
    writeProductMetadata(fwd(join(fakeInstall, "League of Legends")), fwd(fakeInstall));

    // The manifest entry does not exist on disk, so discovery must keep looking.
    const found = discoverRiotInstall();
    expect(found.source).toBe("product-metadata");
    expect(found.leagueDir).toBe(join(fakeInstall, "League of Legends"));
  });

  it("survives a corrupt manifest rather than throwing", () => {
    const dir = join(programData, "Riot Games");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "RiotClientInstalls.json"), "{ not json", "utf8");

    expect(() => discoverRiotInstall()).not.toThrow();
    expect(discoverRiotInstall().source).toBe("default");
  });
});

describe("fallbacks", () => {
  it("uses product metadata when no manifest exists", () => {
    writeProductMetadata(fwd(join(fakeInstall, "League of Legends")), fwd(fakeInstall));

    const found = discoverRiotInstall();
    expect(found.source).toBe("product-metadata");
    expect(found.rcServices).toBe(join(fakeInstall, "Riot Client", "RiotClientServices.exe"));
  });

  it("falls back to the default root when Riot has recorded nothing", () => {
    const found = discoverRiotInstall();
    expect(found.source).toBe("default");
    expect(found.rcServices).toContain("Riot Client");
  });

  it("lets an explicit override win over everything", () => {
    writeInstallsManifest({ rc_live: "C:/Riot Games/Riot Client/RiotClientServices.exe" });
    process.env.LEAGUESWITCHER_RIOT_ROOT = fakeInstall;
    resetRiotInstallCache();

    const found = discoverRiotInstall();
    expect(found.source).toBe("override");
    expect(found.leagueDir).toBe(join(fakeInstall, "League of Legends"));
  });
});
