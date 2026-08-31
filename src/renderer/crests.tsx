/**
 * The rank crests, inlined as an SVG sprite exactly as the mockup does.
 *
 * These are Riot's own mini-crests from Community Dragon, already colour-corrected and
 * viewBox-normalised by scripts/fetch-crests.mjs (diamond ships a purple almost identical to
 * Master's; see that script). Inlining the sprite rather than loading eleven files means the
 * grid never flashes crest-less on first paint, and the app works offline from the first run.
 *
 * The runtime cache in assets/cache.ts still downloads fresh copies — this is the floor, not
 * the only source.
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";

const TIERS = [
  "iron", "bronze", "silver", "gold", "platinum", "emerald",
  "diamond", "master", "grandmaster", "challenger", "unranked",
] as const;

export type TierKey = (typeof TIERS)[number];

export function normaliseTier(tier: string | null | undefined): TierKey {
  const key = (tier ?? "").toLowerCase();
  return (TIERS as readonly string[]).includes(key) ? (key as TierKey) : "unranked";
}

/**
 * Loads each tier's SVG from the main process once and mounts them as <symbol>s, so cards can
 * reference them with <use href="#crest-diamond"/> just as the mockup does.
 */
export function CrestSprite(): JSX.Element {
  const [symbols, setSymbols] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded: Record<string, string> = {};
      for (const tier of TIERS) {
        try {
          const svg = await window.api.getCrest(tier);
          if (svg) loaded[tier] = svg;
        } catch {
          /* a missing crest costs an icon, not the grid */
        }
      }
      if (!cancelled) setSymbols(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      {Object.entries(symbols).map(([tier, svg]) => (
        <symbol
          key={tier}
          id={`crest-${tier}`}
          viewBox="0 0 20 20"
          preserveAspectRatio="xMidYMid meet"
          // The fetched file is a full <svg> document; only its inner markup belongs in a symbol.
          dangerouslySetInnerHTML={{ __html: stripSvgWrapper(svg) }}
        />
      ))}
    </svg>
  );
}

/** Pull the contents out of an <svg> element, discarding the wrapper's own attributes. */
function stripSvgWrapper(svg: string): string {
  const open = svg.indexOf(">");
  const close = svg.lastIndexOf("</svg>");
  if (open < 0 || close < 0) return svg;
  return svg.slice(open + 1, close);
}

/**
 * `size` is required whenever `className` is not the default `.crest`, because an <svg> with
 * neither a class nor explicit dimensions expands to fill its container — which it duly did,
 * turning the active-account strip's crest into a full-width graphic.
 */
export function Crest({
  tier,
  className = "crest",
  size,
}: {
  tier: string;
  className?: string;
  size?: number;
}): JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      aria-hidden="true"
      style={size ? { width: size, height: size, flex: "none" } : undefined}
    >
      <use href={`#crest-${normaliseTier(tier)}`} />
    </svg>
  );
}
