/**
 * Secret scanner. Run standalone or as a pre-commit hook.
 *
 *   node scripts/scan-secrets.mjs            # scan staged changes (hook mode)
 *   node scripts/scan-secrets.mjs --all      # scan the whole working tree
 *
 * Exits non-zero if anything matches, which blocks the commit.
 *
 * This exists because a real test-account password once reached a committed file as
 * placeholder UI text. Assume it will happen again; let the machine catch it.
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";

/**
 * Hard failures — actual credentials. These block the commit.
 *
 * Every rule here is SHAPE-based on purpose. An earlier version listed the maintainer's real
 * usernames and the literal pattern of their password, which meant the scanner itself was the
 * thing leaking them — a detector that has to be scrubbed before publishing is worse than no
 * detector. Nothing below reveals anything about any specific account.
 */
const RULES = [
  { name: "Riot API key", re: /RGAPI-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/ },
  { name: "JWT / refresh token", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { name: "refresh_token field", re: /refresh_token["'\s:=]+["'][A-Za-z0-9._-]{40,}/ },
  { name: "Riot lockfile contents", re: /^(Riot Client|LeagueClient):\d+:\d+:[^:]+:https?$/m },
  { name: "private settings blob", re: /rso-authenticator:\s*\n\s*tdid:/ },
  // A password assigned to a literal, anywhere. Catches credentials pasted into a fixture or a
  // placeholder that turned out to be real — which is how a live password once reached a
  // committed file as UI sample text.
  { name: "hardcoded password", re: /\b(password|passwd|pwd)\b\s*[:=]\s*["'][^"'\s]{6,}["']/i },
];

/**
 * Warnings — identifying but not secret, and not worth blocking a commit over.
 *
 * `scripts/scrub-personal.mjs` is what removes real account identifiers before publishing;
 * this only flags the obvious shapes so a stray one is visible.
 */
const WARN_RULES = [
  { name: "possible Riot ID", re: /\b[A-Za-z0-9][A-Za-z0-9 ]{2,15}#[A-Z0-9]{2,5}\b/ },
];

/** Inline opt-out marker, e.g. `// scan-secrets: allow — fixture`. */
const ALLOW = /scan-secrets:\s*allow/;

const SKIP_DIRS = /(^|[\\/])(\.git|node_modules|dist|out|release|coverage|\.vite)([\\/]|$)/;
const SKIP_FILES = /(package-lock\.json|\.png|\.jpg|\.jpeg|\.gif|\.ico|\.woff2?|\.ttf)$/i;

const all = process.argv.includes("--all");
let files;
try {
  files = execSync(all ? "git ls-files" : "git diff --cached --name-only --diff-filter=ACM", {
    encoding: "utf8",
  })
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
} catch {
  console.error("scan-secrets: not a git repository");
  process.exit(0);
}

const hits = [];
const warns = [];
for (const f of files) {
  if (SKIP_DIRS.test(f) || SKIP_FILES.test(f)) continue;
  if (!existsSync(f) || !statSync(f).isFile()) continue;
  if (statSync(f).size > 3_000_000) continue;

  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }

  const allLines = text.split(String.fromCharCode(10));
  text.split("\n").forEach((line, i) => {
    // An explicit, greppable opt-out for lines that legitimately look like credentials —
    // test fixtures, mostly. Deliberately not automatic: "it is in tests/" is not a reason
    // to stop looking, and a real password pasted into a fixture is still a real password.
    if (ALLOW.test(line) || ALLOW.test(allLines[i - 1] ?? "")) return;
    const entry = (rule) => ({ file: f, line: i + 1, rule: rule.name, snippet: line.trim().slice(0, 90) });
    for (const rule of RULES) if (rule.re.test(line)) hits.push(entry(rule));
    for (const rule of WARN_RULES) if (rule.re.test(line)) warns.push(entry(rule));
  });
}

if (warns.length) {
  const byFile = new Map();
  for (const w of warns) byFile.set(w.file, (byFile.get(w.file) ?? 0) + 1);
  console.warn(`\n  note: login usernames appear in ${byFile.size} file(s) — not secret, not blocking`);
  for (const [f, n] of byFile) console.warn(`        ${f} (${n})`);
  console.warn("");
}

if (hits.length) {
  console.error(`\n  SECRET SCAN FAILED — ${hits.length} match(es)\n`);
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}`);
    console.error(`     ${h.rule}`);
    console.error(`     ${h.snippet}\n`);
  }
  console.error("  Nothing sensitive belongs in this repo. Runtime data lives in");
  console.error("  %APPDATA%\\LeagueSwitcher\\. Remove these, then commit again.\n");
  process.exit(1);
}

console.log(`scan-secrets: clean (${files.length} file${files.length === 1 ? "" : "s"} checked)`);
