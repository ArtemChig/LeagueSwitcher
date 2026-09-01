/**
 * Replace the repository owner's real account identifiers with neutral placeholders.
 *
 * The bug write-ups in this repo are worth keeping — they name the accounts involved, because
 * naming them is what made the failures legible ("switch X signed in as Y"). But the login
 * usernames, Riot IDs and puuids of real accounts do not belong in a public repo, and once
 * pushed they are in the history permanently.
 *
 * So the narratives stay and the identifiers become placeholders. Every substitution keeps the
 * same shape — a login username stays a login username — so the explanations still read.
 *
 *   node scripts/scrub-personal.mjs           report what would change
 *   node scripts/scrub-personal.mjs --write   apply it
 *
 * Also usable as a history filter, where it rewrites whatever tree it is pointed at.
 */
import { readFileSync, writeFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

/** Longest first, so a substring never shadows a longer match. */
export const REPLACEMENTS = [
  // Riot IDs (display names)
  ["SUMMONER ONE", "SUMMONER ONE"],
  ["SUMMONER TWO", "SUMMONER TWO"],
  ["SUMMONER THREE", "SUMMONER THREE"],
  ["SUMMONER FOUR", "SUMMONER FOUR"],
  ["SUMMONER FIVE", "SUMMONER FIVE"],
  ["SUMMONER SIX", "SUMMONER SIX"],
  ["SUMMONER SEVEN", "SUMMONER SEVEN"],
  ["SUMMONER EIGHT", "SUMMONER EIGHT"],
  ["SUMMONER NINE", "SUMMONER NINE"],

  // Login usernames
  ["accountOne", "accountOne"],
  ["accountTwo", "accountTwo"],
  ["accountTwo", "accountTwo"],
  ["accountThree", "accountThree"],
  ["accountFour", "accountFour"],
  ["accountFive", "accountFive"],
  ["accountSix", "accountSix"],
  ["SUMMONER-EIGHT", "accountSeven"],
  ["accountEight", "accountEight"],
  ["accountNine", "accountNine"],
  ["accountTen", "accountTen"],

  // Identifiers
  ["<puuid-key-A>", "<puuid-key-A>"],
  ["<puuid-key-B>", "<puuid-key-B>"],
  ["<local-puuid-1>", "<local-puuid-1>"],
  ["<local-puuid-2>", "<local-puuid-2>"],
  ["<local-puuid-3>", "<local-puuid-3>"],
  ["<local-puuid-4>", "<local-puuid-4>"],
  ["<summoner-id>", "<summoner-id>"],
  ["<email>", "<email>"],

  // Riot developer app id
  ["<app-id>", "<app-id>"],
].sort((a, b) => b[0].length - a[0].length);

/** Tags only ever appear attached to a Riot ID, so they are handled as whole tokens. */
const TAG_PATTERNS = [
  [/#TAG3\b/g, "#TAG3"],
  [/#TAG1\b/g, "#TAG1"],
  [/#TAG2\b/g, "#TAG2"],
  [/#TAG4\b/g, "#TAG4"],
  [/#TAG5\b/g, "#TAG5"],
];

const SKIP = /(^|[\\/])(\.git|node_modules|dist|out|release|coverage|ui-check|assets[\\/]brand)([\\/]|$)/;
const BINARY = /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|exe|enc)$/i;

/**
 * Every form an identifier actually appears in.
 *
 * The first pass missed two and left the tree half-scrubbed: account ids are lowercased
 * (`accountOne` becomes `accountone`), and Riot IDs get percent-encoded into URLs
 * (`SUMMONER ONE` becomes `SUMMONER%20ONE`). Both are the same identifier and both
 * need to go, so the variants are derived rather than hand-listed.
 */
function variantsOf(from, to) {
  const out = [[from, to]];
  const lower = from.toLowerCase();
  const upper = from.toUpperCase();
  if (lower !== from) out.push([lower, to.toLowerCase().replace(/[ ]/g, "")]);
  if (upper !== from) out.push([upper, to.toUpperCase().replace(/[ ]/g, "")]);
  if (from.includes(" ")) {
    out.push([from.replace(/ /g, "%20"), to.replace(/ /g, "%20")]);
    out.push([from.replace(/ /g, "-"), to.replace(/ /g, "-")]);
    out.push([lower.replace(/ /g, ""), to.toLowerCase().replace(/ /g, "")]);
  }
  return out;
}

const ALL_REPLACEMENTS = REPLACEMENTS.flatMap(([f, t]) => variantsOf(f, t))
  .sort((a, b) => b[0].length - a[0].length);

export function scrubText(text) {
  let out = text;
  for (const [from, to] of ALL_REPLACEMENTS) out = out.split(from).join(to);
  for (const [re, to] of TAG_PATTERNS) out = out.replace(re, to);
  return out;
}

const write = process.argv.includes("--write");
const quiet = process.argv.includes("--quiet");

// --stdin: filter a commit message. Used as git filter-branch's --msg-filter, because the
// identifiers appear in the history's prose as well as its files.
if (process.argv.includes("--stdin")) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  process.stdout.write(scrubText(Buffer.concat(chunks).toString("utf8")));
  process.exit(0);
}

/**
 * Walk the tree directly.
 *
 * `git ls-files` is the right list when run normally, but as a --tree-filter this runs inside a
 * detached checkout where it reports nothing — which would scrub zero files while reporting
 * success, leaving the history untouched. --walk avoids that trap.
 */
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (SKIP.test(full)) continue;
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile()) acc.push(full);
  }
  return acc;
}

let files;
if (process.argv.includes("--walk")) {
  files = walk(".");
} else {
  try {
    files = execSync("git ls-files", { encoding: "utf8" })
      .split(String.fromCharCode(10))
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    console.error("scrub-personal: not a git repository");
    process.exit(1);
  }
}

let changed = 0;
let hits = 0;
for (const f of files) {
  if (SKIP.test(f) || BINARY.test(f)) continue;
  if (!existsSync(f) || !statSync(f).isFile()) continue;

  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }

  const next = scrubText(text);
  if (next === text) continue;

  // Count what actually moved, for the report.
  let n = 0;
  for (const [from] of ALL_REPLACEMENTS) n += text.split(from).length - 1;
  for (const [re] of TAG_PATTERNS) n += (text.match(re) ?? []).length;

  changed++;
  hits += n;
  if (!quiet) console.log(`  ${write ? "scrubbed" : "would scrub"}  ${f}  (${n})`);
  if (write) writeFileSync(f, next, "utf8");
}

if (!quiet) console.log(
  changed === 0
    ? "\nNothing to scrub — no personal identifiers found."
    : `\n${write ? "Scrubbed" : "Would scrub"} ${hits} occurrence(s) across ${changed} file(s).` +
      (write ? "" : "\nRe-run with --write to apply.")
);
