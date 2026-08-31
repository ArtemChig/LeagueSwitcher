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

/** Hard failures — actual credentials. These block the commit. */
const RULES = [
  { name: "Riot API key", re: /RGAPI-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/ },
  { name: "JWT / refresh token", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { name: "refresh_token field", re: /refresh_token["'\s:=]+["'][A-Za-z0-9._-]{40,}/ },
  { name: "test account password", re: /temtem\d{4}RG/ },
  { name: "Riot lockfile contents", re: /^(Riot Client|LeagueClient):\d+:\d+:[^:]+:https?$/m },
  { name: "private settings blob", re: /rso-authenticator:\s*\n\s*tdid:/ },
];

/**
 * Warnings — identifying but not secret. Login usernames appear legitimately in the
 * planning docs, and they are useless without a password. Surfaced so they stay a
 * deliberate choice, but they do not block a commit.
 */
const WARN_RULES = [
  { name: "test account username", re: /\b(accountFour|accountThree|accountTwo|accountOne)\b/ },
];

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

  text.split("\n").forEach((line, i) => {
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
