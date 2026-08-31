/**
 * Download Riot's rank mini-crests once and bundle them into the app.
 *
 *   node scripts/fetch-crests.mjs
 *
 * These are Riot's own assets from Community Dragon, not hand-drawn substitutes (PLAN §5).
 * Bundling them means the grid renders correctly offline and on first run, before the runtime
 * cache in %APPDATA% has been populated.
 *
 * Two corrections are applied on the way in, both verified against the artwork:
 *
 *   1. diamond.svg ships tinted #8141EB — a purple all but identical to Master's #9D48E0, so
 *      the two tiers are indistinguishable at 20px. Sampling the full-size emblem-diamond.png
 *      shows the real emblem is blue, so that one fill is rewritten to #4C6FD9. Every other
 *      tier was checked against its emblem and is correct: do NOT "fix" the others.
 *
 *   2. The viewBoxes differ per tier (17x12 through 20x20). Each is wrapped in a uniform
 *      0 0 20 20 viewport with preserveAspectRatio, so the crests line up in a row instead of
 *      jittering by a pixel or two between ranks.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TIERS = [
  "iron", "bronze", "silver", "gold", "platinum", "emerald",
  "diamond", "master", "grandmaster", "challenger", "unranked",
];

const BASE =
  "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-mini-crests";

/** The one documented correction. Keyed by tier so it cannot leak to another. */
const COLOUR_FIXES = {
  diamond: { from: /#8141EB/gi, to: "#4C6FD9" },
};

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "crests");
mkdirSync(outDir, { recursive: true });

/** Re-target a crest into a uniform 0 0 20 20 viewport, preserving its aspect ratio. */
function normaliseViewport(svg) {
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1];
  if (!viewBox) return svg;

  const [minX, minY, width, height] = viewBox.split(/\s+/).map(Number);

  // Centre the original box inside a 20x20 one rather than stretching it.
  const offsetX = minX - (20 - width) / 2;
  const offsetY = minY - (20 - height) / 2;

  return (
    svg
      .replace(/viewBox="[^"]+"/, `viewBox="${offsetX} ${offsetY} 20 20"`)
      .replace(/<svg([^>]*)>/, (m, attrs) =>
        /preserveAspectRatio/.test(attrs) ? m : `<svg${attrs} preserveAspectRatio="xMidYMid meet">`
      )
      // Drop intrinsic width/height on every tier, not just the resized ones: leaving them on
      // some files makes CSS sizing behave differently per rank, which is a maddening bug to
      // chase down later.
      .replace(/\s(width|height)="[^"]*"/g, "")
  );
}

let failures = 0;

for (const tier of TIERS) {
  const url = `${BASE}/${tier}.svg`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      console.log(`  FAIL ${tier}: HTTP ${res.status}`);
      failures++;
      continue;
    }

    let svg = await res.text();
    const originalViewBox = svg.match(/viewBox="([^"]+)"/)?.[1] ?? "?";
    const before = [...new Set([...svg.matchAll(/#[0-9A-Fa-f]{6}/g)].map((m) => m[0]))];

    const fix = COLOUR_FIXES[tier];
    let patched = false;
    if (fix && fix.from.test(svg)) {
      svg = svg.replace(fix.from, fix.to);
      patched = true;
    }

    svg = normaliseViewport(svg);
    writeFileSync(join(outDir, `${tier}.svg`), svg, "utf8");

    const after = [...new Set([...svg.matchAll(/#[0-9A-Fa-f]{6}/g)].map((m) => m[0]))];
    console.log(
      `  ${tier.padEnd(12)} ${String(svg.length).padStart(5)}B  viewBox ${originalViewBox.padEnd(11)} -> 0 0 20 20  ` +
        `${before.join(" ")}${patched ? `  PATCHED -> ${after.join(" ")}` : ""}`
    );
  } catch (err) {
    console.log(`  FAIL ${tier}: ${err.message}`);
    failures++;
  }
}

console.log(`\n${TIERS.length - failures}/${TIERS.length} crests bundled into ${outDir}`);
process.exit(failures === 0 ? 0 : 1);
