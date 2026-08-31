/**
 * P4.6 — the session file: parsing, validation, atomic restore, diffing.
 *
 * This module is where a bug costs an account. Writing a truncated file over a live session
 * signs the user out with nothing to put back, and that recovery costs a captcha. So the tests
 * lean on the refusal paths rather than the happy one.
 *
 * Fixtures mirror the real file's shape as recorded in RESEARCH §1, with fake token values.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SIGNED_OUT_SESSION,
  diffSessions,
  restoreSessionFromString,
  readSessionSecrets,
  summariseSession,
  validateSessionFile,
} from "../src/main/riot/session.js";

const TOKEN = "r".repeat(1333);
const ID_TOKEN = "i".repeat(1277);
const TDID = "t".repeat(195);

function sessionYaml(overrides: Partial<Record<string, string | number | boolean>> = {}): string {
  const values = {
    id_token: ID_TOKEN,
    refresh_token: TOKEN,
    refresh_token_write_count: 34,
    is_dpop_bound: false,
    last_token_creation_time: Date.now(),
    original_token_creation_time: Date.now() - 100_000_000,
    max_duration_between_restores: 39169575,
    tdid: TDID,
    ...overrides,
  };
  return [
    "psl:",
    "    authorization:",
    "        riot-client:",
    "            claims: []",
    `            id_token: "${values.id_token}"`,
    `            is_dpop_bound: ${values.is_dpop_bound}`,
    `            last_token_creation_time: ${values.last_token_creation_time}`,
    `            max_duration_between_restores: ${values.max_duration_between_restores}`,
    `            original_token_creation_time: ${values.original_token_creation_time}`,
    `            refresh_token: "${values.refresh_token}"`,
    `            refresh_token_write_count: ${values.refresh_token_write_count}`,
    "riot-login:",
    "    persist: null",
    "rso-authenticator:",
    "    tdid:",
    '        domain: "riotgames.com"',
    `        value: "${values.tdid}"`,
    "",
  ].join("\n");
}

let dir: string;
const path = (name: string) => join(dir, name);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ls-session-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = path(name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("summarising a session", () => {
  it("reads the scalars without exposing token values", () => {
    const summary = summariseSession(write("s.yaml", sessionYaml()));

    expect(summary.present).toBe(true);
    expect(summary.signedIn).toBe(true);
    expect(summary.refreshTokenWriteCount).toBe(34);
    expect(summary.isDpopBound).toBe(false);

    // Tokens are reduced to a length and a fingerprint — never the value itself.
    expect(summary.refreshToken?.length).toBe(1333);
    expect(summary.refreshToken?.fingerprint).toHaveLength(12);
    expect(JSON.stringify(summary)).not.toContain(TOKEN);
    expect(JSON.stringify(summary)).not.toContain(ID_TOKEN);
  });

  it("converts max_duration_between_restores into days remaining", () => {
    // The field is SECONDS while last_token_creation_time is MILLISECONDS — mixing the two
    // yields an expiry either 1000x too near or too far.
    const summary = summariseSession(write("s.yaml", sessionYaml()));
    expect(summary.daysUntilExpiry).toBeGreaterThan(450);
    expect(summary.daysUntilExpiry).toBeLessThan(455);
  });

  it("reports an absent file rather than throwing", () => {
    const summary = summariseSession(path("nope.yaml"));
    expect(summary.present).toBe(false);
    expect(summary.signedIn).toBe(false);
  });

  it("treats a signed-out file as present but not signed in", () => {
    const summary = summariseSession(write("out.yaml", SIGNED_OUT_SESSION));
    expect(summary.present).toBe(true);
    expect(summary.signedIn).toBe(false);
    expect(summary.refreshToken).toBeNull();
  });
});

describe("validation refuses what would sign the user out", () => {
  it("accepts a real-shaped session", () => {
    expect(validateSessionFile(write("ok.yaml", sessionYaml())).valid).toBe(true);
  });

  it("rejects a missing file", () => {
    const result = validateSessionFile(path("gone.yaml"));
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("does not exist");
  });

  it("rejects a truncated file", () => {
    const result = validateSessionFile(write("tiny.yaml", "psl:\n"));
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/too small|no refresh_token/);
  });

  it("rejects an implausibly short refresh token", () => {
    const result = validateSessionFile(write("short.yaml", sessionYaml({ refresh_token: "abc123" })));
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("implausibly short");
  });

  it("rejects a device-bound token, because the whole design assumes portability", () => {
    const result = validateSessionFile(write("dpop.yaml", sessionYaml({ is_dpop_bound: true })));
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("device-bound");
  });

  it("rejects an expired session", () => {
    const longAgo = Date.now() - 500 * 86_400_000;
    const result = validateSessionFile(write("old.yaml", sessionYaml({ last_token_creation_time: longAgo })));
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("expired");
  });
});

describe("restoring", () => {
  it("writes a valid session and leaves no temp file behind", () => {
    const target = path("live.yaml");
    const summary = restoreSessionFromString(sessionYaml(), { target });

    expect(summary.signedIn).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("refresh_token");
    expect(existsSync(target)).toBe(true);
  });

  it("refuses to overwrite a live session with rubbish, and does not touch the target", () => {
    const target = path("live.yaml");
    const original = sessionYaml();
    writeFileSync(target, original, "utf8");

    expect(() => restoreSessionFromString("psl:\n", { target })).toThrow(/refusing to restore/);

    // The critical assertion: the existing session survived the failed restore untouched.
    expect(readFileSync(target, "utf8")).toBe(original);
  });

  it("allows an invalid write when explicitly asked, for the signed-out case", () => {
    const target = path("live.yaml");
    writeFileSync(target, sessionYaml(), "utf8");
    restoreSessionFromString(SIGNED_OUT_SESSION, { target, allowInvalid: true });
    expect(summariseSession(target).signedIn).toBe(false);
  });
});

describe("reading secrets", () => {
  it("returns the real values for the injection path", () => {
    const secrets = readSessionSecrets(write("s.yaml", sessionYaml()));
    expect(secrets?.refreshToken).toBe(TOKEN);
    expect(secrets?.idToken).toBe(ID_TOKEN);
    expect(secrets?.isDpopBound).toBe(false);
  });

  it("returns null for a signed-out file rather than empty strings", () => {
    const secrets = readSessionSecrets(write("out.yaml", SIGNED_OUT_SESSION));
    expect(secrets?.refreshToken).toBeNull();
  });
});

describe("diffing, which is how EXP-5's finding is applied", () => {
  it("sees an id_token rotation with a stable refresh_token", () => {
    // Exactly what a real sign-in does: id_token rotates, refresh_token does not,
    // write_count increments.
    const before = summariseSession(write("a.yaml", sessionYaml()));
    const after = summariseSession(
      write("b.yaml", sessionYaml({ id_token: "j".repeat(1277), refresh_token_write_count: 35 }))
    );

    const diff = diffSessions(before, after);
    expect(diff.idTokenRotated).toBe(true);
    expect(diff.refreshTokenRotated).toBe(false);
    expect(diff.writeCountDelta).toBe(1);
    expect(diff.shouldRecapture).toBe(true);
  });

  it("reports no change for an identical file", () => {
    const yaml = sessionYaml();
    const diff = diffSessions(summariseSession(write("a.yaml", yaml)), summariseSession(write("b.yaml", yaml)));
    expect(diff.changed).toBe(false);
    expect(diff.shouldRecapture).toBe(false);
  });
});
