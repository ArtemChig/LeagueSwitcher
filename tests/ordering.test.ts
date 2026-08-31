/**
 * Card ordering.
 *
 * An unknown tier resolves to -1, and -1 sorts FIRST in an ascending comparator — so the
 * natural way to write this puts unranked accounts above Challenger. That is the bug being
 * pinned here, and it is invisible until you happen to have both on screen.
 */
import { describe, expect, it } from "vitest";
import { compareForRankSort, tierRank, type Orderable } from "../src/main/store/ordering.js";

const account = (rankLabel: string, riotIdLabel = rankLabel, isActive = false): Orderable => ({
  rankLabel,
  riotIdLabel,
  isActive,
});

const order = (list: Orderable[]) => [...list].sort(compareForRankSort).map((a) => a.riotIdLabel);

describe("tierRank", () => {
  it("ranks higher tiers ahead of lower ones", () => {
    expect(tierRank("CHALLENGER I")).toBeLessThan(tierRank("IRON IV"));
    expect(tierRank("DIAMOND IV")).toBeLessThan(tierRank("PLATINUM I"));
  });

  it("puts unranked below every real tier", () => {
    for (const tier of ["CHALLENGER I", "IRON IV", "BRONZE II", "MASTER I"]) {
      expect(tierRank("Unranked")).toBeGreaterThan(tierRank(tier));
    }
  });

  it("treats an unknown, empty or missing label as unranked rather than as top rank", () => {
    for (const label of ["Unranked", "", "   ", "WOOD V", null, undefined]) {
      expect(tierRank(label)).toBeGreaterThan(tierRank("IRON IV"));
    }
  });
});

describe("rank sort", () => {
  it("puts unranked last, not first", () => {
    expect(
      order([account("Unranked", "unranked"), account("BRONZE I", "bronze"), account("DIAMOND IV", "diamond")])
    ).toEqual(["diamond", "bronze", "unranked"]);
  });

  it("orders a full ladder correctly", () => {
    const ladder = [
      "IRON IV", "GOLD II", "CHALLENGER I", "Unranked", "EMERALD III",
      "MASTER I", "SILVER I", "GRANDMASTER I", "PLATINUM IV", "DIAMOND II", "BRONZE III",
    ].map((t) => account(t));

    expect(order(ladder)).toEqual([
      "CHALLENGER I", "GRANDMASTER I", "MASTER I", "DIAMOND II", "EMERALD III",
      "PLATINUM IV", "GOLD II", "SILVER I", "BRONZE III", "IRON IV", "Unranked",
    ]);
  });

  it("keeps several unranked accounts together at the bottom", () => {
    expect(
      order([
        account("Unranked", "zed"),
        account("GOLD I", "gold"),
        account("Unranked", "ahri"),
      ])
    ).toEqual(["gold", "ahri", "zed"]);
  });

  it("pins the active account above everything, even when it is unranked", () => {
    expect(
      order([
        account("CHALLENGER I", "chall"),
        account("Unranked", "me", true),
        account("GOLD I", "gold"),
      ])
    ).toEqual(["me", "chall", "gold"]);
  });

  it("breaks ties on the same tier by name", () => {
    expect(order([account("GOLD I", "zoe"), account("GOLD I", "annie")])).toEqual(["annie", "zoe"]);
  });
});
