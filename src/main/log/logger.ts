/**
 * P4.1 — the log file, with redaction that cannot be bypassed.
 *
 * PLAN §2.3: "The logger has a mandatory redaction pass — unit-tested, so a token can never
 * reach a log file." Mandatory is the operative word. There is no `writeRaw`, no escape hatch
 * and no option to disable scrubbing: every path to disk goes through `redact()`. A logger with
 * a bypass is a logger that will eventually be bypassed, at 3am, by someone debugging.
 *
 * Rotation is size-based and deliberately simple — one previous file kept. Logs here are for
 * diagnosing a failed switch, not for archival.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, readFileSync } from "node:fs";
import { appPaths } from "../riot/paths.js";
import { redact } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const MAX_BYTES = 2 * 1024 * 1024;

export interface LoggerOptions {
  /** Minimum level written. Defaults to info, or debug with LEASWITCHER_DEBUG set. */
  level?: LogLevel;
  /** Also mirror to the console. On by default for the CLI, off for the packaged app. */
  console?: boolean;
  /** Override the log file, for tests. */
  file?: string;
}

export class Logger {
  private level: LogLevel;
  private toConsole: boolean;
  private file: string;
  /** Set when writing has failed, so a broken log cannot take the app down with it. */
  private disabled = false;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? (process.env.LEAGUESWITCHER_DEBUG ? "debug" : "info");
    this.toConsole = options.console ?? false;
    this.file = options.file ?? appPaths.logFile;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string, context?: unknown): void {
    this.write("debug", message, context);
  }
  info(message: string, context?: unknown): void {
    this.write("info", message, context);
  }
  warn(message: string, context?: unknown): void {
    this.write("warn", message, context);
  }
  error(message: string, context?: unknown): void {
    this.write("error", message, context);
  }

  /**
   * The single path to disk. Both the message and any context are scrubbed — context is where
   * secrets actually travel, since it is usually an object someone passed straight through.
   */
  private write(level: LogLevel, message: string, context?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const line =
      `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${redact(message)}` +
      (context === undefined ? "" : ` | ${redact(context).replace(/\s*\n\s*/g, " ")}`);

    if (this.toConsole) console.log(line);
    if (this.disabled) return;

    try {
      mkdirSync(appPaths.logs, { recursive: true });
      this.rotateIfNeeded();
      appendFileSync(this.file, line + "\n", "utf8");
    } catch {
      // A log that cannot be written must never break a switch. Fail quiet, once.
      this.disabled = true;
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.file)) return;
      if (statSync(this.file).size < MAX_BYTES) return;
      const previous = `${this.file}.1`;
      if (existsSync(previous)) unlinkSync(previous);
      renameSync(this.file, previous);
    } catch {
      /* rotation is best-effort */
    }
  }

  /** Test helper: read back what was written. */
  readAll(): string {
    try {
      return existsSync(this.file) ? readFileSync(this.file, "utf8") : "";
    } catch {
      return "";
    }
  }
}

let singleton: Logger | null = null;

export function getLogger(): Logger {
  singleton ??= new Logger({ console: Boolean(process.env.LEAGUESWITCHER_DEBUG) });
  return singleton;
}

export function resetLoggerForTests(): void {
  singleton = null;
}
