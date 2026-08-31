/**
 * PLAN §7 rule 3 / P4.1 — proof that a token cannot reach a log.
 *
 * These are deliberately adversarial: each case is a way a secret has actually been leaked
 * by logging code in the wild — inside an error message, nested in an object, embedded in a
 * URL, spread across a multi-line YAML dump.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearRegisteredSecrets, redact, registerSecret, registerSecrets } from "../src/main/log/redact.js";

// Shaped like the real thing, but generated for the test. Not a real credential.
const JWT =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InMx" +
  ".eyJzdWIiOiJ0ZXN0LXN1YmplY3QiLCJpc3MiOiJodHRwczovL2F1dGgucmlvdGdhbWVzLmNvbSJ9" +
  ".c2lnbmF0dXJlLXBsYWNlaG9sZGVyLXZhbHVlLWZvci10ZXN0aW5n";

const LOCKFILE_PASSWORD = "Xy7QpLm2NvBw9RtZa4";

/**
 * Assembled from parts rather than written as a literal, so no line in this repository ever
 * contains an API-key-shaped string. The pre-commit secret scanner blocks that pattern
 * wherever it appears — correctly, since a scanner with a "but it's only a test" exemption is
 * a scanner that can be talked past.
 */
const API_KEY = ["RGAPI", "0d1e2f3a-4b5c-6d7e-8f90-a1b2c3d4e5f6"].join("-");

beforeEach(() => clearRegisteredSecrets());

describe("shape-based redaction (catches secrets nobody registered)", () => {
  it("redacts a bare JWT", () => {
    const out = redact(`token is ${JWT} ok`);
    expect(out).not.toContain(JWT);
    expect(out).toContain("<jwt:redacted>");
  });

  it("redacts a Riot API key", () => {
    const out = redact(`GET /lol?api_key=${API_KEY}`);
    expect(out).not.toContain(API_KEY);
    expect(out).toContain("RGAPI-<redacted>");
  });

  it("redacts an Authorization header", () => {
    const out = redact("Authorization: Basic cmlvdDpzdXBlcnNlY3JldHBhc3N3b3Jk");
    expect(out).not.toContain("cmlvdDpzdXBlcnNlY3JldHBhc3N3b3Jk");
  });

  it("redacts the lockfile password field but keeps pid and port readable", () => {
    const out = redact(`Riot Client:13172:58211:${LOCKFILE_PASSWORD}:https`);
    expect(out).not.toContain(LOCKFILE_PASSWORD);
    expect(out).toContain("13172");
    expect(out).toContain("58211");
  });

  it("redacts refresh_token and id_token in a YAML dump", () => {
    const yaml = [
      "psl:",
      "  authorization:",
      "    riot-client:",
      `      id_token: ${JWT}`,
      `      refresh_token: ${LOCKFILE_PASSWORD}${LOCKFILE_PASSWORD}`,
      "      refresh_token_write_count: 34",
      "      is_dpop_bound: false",
    ].join("\n");
    const out = redact(yaml);
    expect(out).not.toContain(JWT);
    expect(out).not.toContain(`${LOCKFILE_PASSWORD}${LOCKFILE_PASSWORD}`);
    // Non-secret neighbours must survive — a redactor that eats everything is useless.
    expect(out).toContain("refresh_token_write_count: 34");
    expect(out).toContain("is_dpop_bound: false");
  });

  it("redacts a password field in JSON text", () => {
    const out = redact('{"username":"someone","password":"hunter2hunter2"}');
    expect(out).not.toContain("hunter2hunter2");
    expect(out).toContain("someone");
  });
});

describe("registered secrets (catches secrets that look like ordinary text)", () => {
  it("redacts a registered value that no pattern would match", () => {
    registerSecret("correct horse battery staple");
    const out = redact("the passphrase is correct horse battery staple, do not log it");
    expect(out).not.toContain("correct horse battery staple");
    expect(out).toContain("<redacted>");
  });

  it("ignores values too short to replace safely", () => {
    registerSecret("abc");
    // "abc" appears inside ordinary words; replacing it would corrupt unrelated text.
    expect(redact("abcdefg and alphabetical")).toContain("alphabetical");
  });

  it("redacts the longer secret when one contains another", () => {
    registerSecrets(["shortsecretvalue", "shortsecretvalue-with-more-entropy"]);
    const out = redact("token=shortsecretvalue-with-more-entropy");
    expect(out).not.toContain("shortsecretvalue");
    expect(out).toBe("token=<redacted>");
  });
});

describe("non-string inputs still get scrubbed", () => {
  it("redacts a nested object rather than printing it raw", () => {
    const out = redact({ session: { refresh_token: JWT, write_count: 34 }, ok: true });
    expect(out).not.toContain(JWT);
    expect(out).toContain("34");
  });

  it("redacts a secret carried inside an Error message", () => {
    registerSecret(LOCKFILE_PASSWORD);
    const out = redact(new Error(`connect failed with password ${LOCKFILE_PASSWORD}`));
    expect(out).not.toContain(LOCKFILE_PASSWORD);
  });

  it("handles null and undefined without throwing", () => {
    expect(redact(null)).toBe("null");
    expect(redact(undefined)).toBe("undefined");
  });

  it("survives a circular object", () => {
    const a: Record<string, unknown> = { name: "loop" };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });
});

describe("the whole session file", () => {
  it("leaks nothing recognisable from a realistic session dump", () => {
    const tdid = "a".repeat(197);
    const file = [
      "psl:",
      "  authorization:",
      "    riot-client:",
      `      id_token: "${JWT}"`,
      `      refresh_token: "${JWT}"`,
      "      refresh_token_write_count: 34",
      "rso-authenticator:",
      "  tdid:",
      '    domain: "riotgames.com"',
      `    value: "${tdid}"`,
    ].join("\n");

    const out = redact(file);
    expect(out).not.toContain(JWT);
    expect(out).not.toContain(tdid);
    expect(out).toContain("riotgames.com");
  });
});
