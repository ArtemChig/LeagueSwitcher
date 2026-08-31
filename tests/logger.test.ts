/**
 * P4.1 — proof that a token never reaches a log FILE.
 *
 * tests/redact.test.ts proves the scrubber works on strings. This proves the property that
 * actually matters: that the bytes on disk contain no secret, however the secret was passed in.
 * Each case writes through the real logger to a real temp file and then greps that file.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../src/main/log/logger.js";
import { clearRegisteredSecrets, registerSecret } from "../src/main/log/redact.js";

const JWT =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9" +
  ".eyJzdWIiOiJ0ZXN0Iiwic2NvcGUiOiJvcGVuaWQifQ" +
  ".c2lnbmF0dXJlLWZvci10ZXN0aW5nLW9ubHk";

const LOCKFILE_PASSWORD = "Kp9WqZ2mNbVc7XsTd4";

let dir: string;
let logFile: string;
let log: Logger;

beforeEach(() => {
  clearRegisteredSecrets();
  dir = mkdtempSync(join(tmpdir(), "ls-log-"));
  logFile = join(dir, "app.log");
  log = new Logger({ file: logFile, level: "debug", console: false });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const onDisk = () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");

describe("nothing secret reaches the log file", () => {
  it("scrubs a token passed in the message", () => {
    log.info(`restoring session with refresh_token: ${JWT}`);
    expect(onDisk()).not.toContain(JWT);
    expect(onDisk()).toContain("restoring session");
  });

  it("scrubs a token passed in the context object", () => {
    // This is the realistic leak: an object handed straight to the logger.
    log.info("session summary", { refresh_token: JWT, write_count: 34, dpop: false });
    const written = onDisk();
    expect(written).not.toContain(JWT);
    expect(written).toContain("34");
  });

  it("scrubs a lockfile password even when only the raw line is logged", () => {
    log.debug(`lockfile: Riot Client:13172:58211:${LOCKFILE_PASSWORD}:https`);
    const written = onDisk();
    expect(written).not.toContain(LOCKFILE_PASSWORD);
    expect(written).toContain("58211");
  });

  it("scrubs a registered secret that no pattern would recognise", () => {
    const password = "a perfectly ordinary sentence";
    registerSecret(password);
    log.warn(`login failed for user with password ${password}`);
    expect(onDisk()).not.toContain(password);
  });

  it("scrubs a secret carried inside a thrown Error", () => {
    registerSecret(LOCKFILE_PASSWORD);
    const err = new Error(`connect ECONNREFUSED using ${LOCKFILE_PASSWORD}`);
    log.error("switch failed", err);
    expect(onDisk()).not.toContain(LOCKFILE_PASSWORD);
  });

  it("scrubs an entire session file dumped as a message", () => {
    const yaml = [
      "psl:",
      "  authorization:",
      "    riot-client:",
      `      id_token: "${JWT}"`,
      `      refresh_token: "${JWT}"`,
      "      refresh_token_write_count: 41",
    ].join("\n");
    log.debug("session file", yaml);
    const written = onDisk();
    expect(written).not.toContain(JWT);
    expect(written).toContain("41");
  });

  it("keeps every entry on one line, so a multi-line secret cannot slip past a line-based scan", () => {
    log.info("multi", { a: 1, b: { c: 2 } });
    const lines = onDisk().trim().split("\n");
    expect(lines).toHaveLength(1);
  });
});

describe("logging never breaks the caller", () => {
  it("survives an unwritable path instead of throwing", () => {
    const broken = new Logger({ file: join(dir, "no", "such", "dir", "x.log"), console: false });
    // mkdir is attempted on appPaths.logs, not this path, so the append fails — and must not throw.
    expect(() => broken.info("hello")).not.toThrow();
    expect(() => broken.info("still fine")).not.toThrow();
  });

  it("survives a circular context object", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    expect(() => log.info("circular", circular)).not.toThrow();
  });

  it("respects the level threshold", () => {
    const quiet = new Logger({ file: logFile, level: "warn", console: false });
    quiet.debug("should not appear");
    quiet.info("should not appear either");
    quiet.warn("should appear");
    const written = onDisk();
    expect(written).not.toContain("should not appear");
    expect(written).toContain("should appear");
  });
});
