/**
 * Redaction — PLAN §7 rule 3: a token, password, API key or lockfile password must never
 * reach a log file. That is enforced here, in code, rather than by remembering to be careful
 * at every call site.
 *
 * Two layers, because either alone leaks:
 *
 *   1. Registration. Anything the app *knows* is a secret (a lockfile password, a refresh
 *      token it just read) is registered, and every later log line has it replaced verbatim.
 *      Catches secrets that look like ordinary text.
 *   2. Shape matching. Patterns for JWTs, Riot API keys, Basic auth headers and the
 *      session file's own key names. Catches secrets nobody remembered to register.
 *
 * Tested in tests/redact.test.ts, which is the actual proof this works.
 */

/** Secrets registered at runtime. Kept longest-first so overlaps redact the longer match. */
const registered = new Set<string>();

/** Below this length a "secret" is too short to replace safely — it would corrupt normal text. */
const MIN_SECRET_LENGTH = 8;

export function registerSecret(value: string | null | undefined): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return;
  registered.add(trimmed);
}

export function registerSecrets(values: Array<string | null | undefined>): void {
  for (const v of values) registerSecret(v);
}

/** Test-only: clear registered secrets between cases. */
export function clearRegisteredSecrets(): void {
  registered.clear();
}

/**
 * Shape-based rules. Order matters: the more specific pattern must run first, or a general
 * one consumes the text the specific one was meant to label.
 */
const PATTERNS: Array<{ re: RegExp; with: string }> = [
  // Riot personal/development API keys.
  { re: /RGAPI-[0-9a-fA-F-]{8,}/g, with: "RGAPI-<redacted>" },

  // JWTs — the id_token and access tokens are all this shape.
  { re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, with: "<jwt:redacted>" },

  // HTTP auth headers, including the lockfile's Basic riot:<password>.
  { re: /\b(Authorization|authorization)\s*:\s*(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]+/g, with: "$1: $2 <redacted>" },
  { re: /\bBasic\s+[A-Za-z0-9+/=]{12,}/g, with: "Basic <redacted>" },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, with: "Bearer <redacted>" },

  // Session-file and API field names, in YAML (`key: value`) or JSON (`"key": "value"`) form.
  // Group 1 is the key's optional quote, reused as its closing quote, so both spellings match.
  // The value must not already be a redaction marker, or this rule re-redacts its own output
  // and destroys the more specific label a rule above it applied.
  {
    re: /("?)\b(refresh_token|id_token|access_token|accessToken|idToken|refreshToken|login_token|loginToken|password|X-Riot-Token|apiKey|api_key)\b\1(\s*[:=]\s*)("?)((?!<redacted>|<jwt:redacted>|RGAPI-<redacted>)[^"\s,}\r\n]{4,})\4/g,
    with: "$1$2$1$3$4<redacted>$4",
  },

  // The lockfile itself: name:pid:port:password:protocol
  { re: /\b([A-Za-z ]+):(\d+):(\d+):([^:\s]{8,}):(https?)\b/g, with: "$1:$2:$3:<redacted>:$5" },

  // The trusted-device cookie, which appears as a bare `value:` under tdid.
  {
    re: /("?)\b(value)\b\1(\s*[:=]\s*)("?)((?!<redacted>)[A-Za-z0-9._~+/=-]{40,})\4/g,
    with: "$1$2$1$3$4<redacted>$4",
  },
];

/**
 * Scrub a string. Always call this on anything heading for a log, a file, or a terminal.
 * Non-strings are stringified first so an accidental `redact(someObject)` still gets scrubbed
 * rather than printing "[object Object]" or, worse, a raw JSON dump of a token.
 */
export function redact(value: unknown): string {
  let text = stringify(value);

  // Registered secrets first: they are exact and unambiguous.
  // Longest-first so a token that contains a shorter registered value is fully covered.
  const secrets = [...registered].sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    if (secret && text.includes(secret)) text = text.split(secret).join("<redacted>");
  }

  for (const rule of PATTERNS) text = text.replace(rule.re, rule.with);

  return text;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, replacerForKnownSecretKeys, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Keys whose values are secret regardless of shape — dropped before they are ever serialised. */
const SECRET_KEYS = new Set([
  "refresh_token", "refreshToken", "id_token", "idToken", "access_token", "accessToken",
  "login_token", "loginToken", "password", "apiKey", "api_key", "X-Riot-Token", "token",
]);

function replacerForKnownSecretKeys(key: string, value: unknown): unknown {
  return SECRET_KEYS.has(key) && typeof value === "string" ? "<redacted>" : value;
}

/**
 * A stable, non-reversible short id for a secret. Lets logs and the UI say "the token changed"
 * without ever showing either value — used throughout the Phase 0 probes and the session code.
 */
export async function fingerprint(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** Synchronous fingerprint for hot paths that already have node:crypto loaded. */
export function fingerprintSync(value: string, createHash: typeof import("node:crypto").createHash): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
