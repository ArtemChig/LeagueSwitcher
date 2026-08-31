/**
 * Routing, rate limiting and link building.
 *
 * These are pure functions with no network, which makes them the one part of Phase 2 that can
 * be proven correct tonight without an API key. They are also where the expensive bugs live:
 * a mis-routed call returns a 404 that is indistinguishable from "no such player", so it shows
 * up as a wrong card rather than an error.
 */
import { describe, expect, it } from "vitest";
import {
  PLATFORM_TO_REGIONAL,
  REGIONAL_FALLBACK,
  platformFromPlatformId,
  platformFromRegion,
  regionalFromPlatform,
} from "../src/main/api/routing.js";
import { RateLimiter, parseRateLimitHeader } from "../src/main/api/rateLimiter.js";
import { buildExternalLinks, buildUggUrl } from "../src/main/api/links.js";

describe("routing tables", () => {
  it("maps the test accounts' regions to platforms", () => {
    // NA and LAN are the two the test accounts span, so cross-region routing is exercised.
    expect(platformFromRegion("NA")).toBe("na1");
    expect(platformFromRegion("LAN")).toBe("la1");
    expect(platformFromRegion("LAS")).toBe("la2");
  });

  it("accepts the platform id the Riot Client reports", () => {
    // userInfo.region.id comes through as "NA1", not "NA".
    expect(platformFromPlatformId("NA1")).toBe("na1");
    expect(platformFromPlatformId("EUW1")).toBe("euw1");
    expect(platformFromPlatformId("KR")).toBe("kr");
  });

  it("routes every platform to a regional cluster", () => {
    for (const platform of Object.keys(PLATFORM_TO_REGIONAL)) {
      expect(regionalFromPlatform(platform), platform).toBeTruthy();
    }
  });

  it("routes americas, europe and asia as documented", () => {
    expect(regionalFromPlatform("na1")).toBe("americas");
    expect(regionalFromPlatform("la1")).toBe("americas");
    expect(regionalFromPlatform("euw1")).toBe("europe");
    expect(regionalFromPlatform("ru")).toBe("europe");
    expect(regionalFromPlatform("kr")).toBe("asia");
  });

  it("gives OCE a fallback route, because that mapping has moved before", () => {
    // PLAN §4.4: OCE has historically used americas for account-v1 and sea for match-v5.
    // The client retries a 404 on the fallback rather than reporting "player not found".
    expect(regionalFromPlatform("oc1")).toBe("sea");
    expect(REGIONAL_FALLBACK.sea).toBe("americas");
  });

  it("returns null rather than guessing for unknown input", () => {
    expect(platformFromRegion("ATLANTIS")).toBeNull();
    expect(platformFromRegion(null)).toBeNull();
    expect(regionalFromPlatform("nowhere")).toBeNull();
  });
});

describe("rate limit header parsing", () => {
  it("parses the documented header", () => {
    // x-app-rate-limit: 100:120,20:1  -> 100 per 120s, 20 per 1s
    expect(parseRateLimitHeader("100:120,20:1")).toEqual([
      { limit: 100, seconds: 120 },
      { limit: 20, seconds: 1 },
    ]);
  });

  it("ignores malformed entries instead of throwing", () => {
    expect(parseRateLimitHeader("garbage")).toEqual([]);
    expect(parseRateLimitHeader(undefined)).toEqual([]);
    expect(parseRateLimitHeader("100:120,broken")).toEqual([{ limit: 100, seconds: 120 }]);
  });
});

describe("rate limiter", () => {
  it("adopts the limits the server reports rather than hardcoded ones", () => {
    const limiter = new RateLimiter();
    limiter.observeHeaders({ "x-app-rate-limit": "500:10,30:1" });
    expect(limiter.snapshot().windows).toEqual([
      { limit: 500, seconds: 10 },
      { limit: 30, seconds: 1 },
    ]);
  });

  it("trusts the server's usage count when it exceeds our own", () => {
    // Another process may share this key, so our own tally is a floor, not the truth.
    const limiter = new RateLimiter();
    limiter.observeHeaders({ "x-app-rate-limit": "100:120,20:1", "x-app-rate-limit-count": "80:120,5:1" });
    const used = limiter.snapshot().used.find((u) => u.seconds === 120);
    expect(used?.used).toBe(80);
  });

  it("blocks for at least the Retry-After it was given", () => {
    const limiter = new RateLimiter();
    const waited = limiter.observe429({ "retry-after": "5" });
    expect(waited).toBe(5000);
    expect(limiter.snapshot().blockedForMs).toBeGreaterThan(4000);
  });

  it("falls back to a sane wait when Retry-After is missing or nonsense", () => {
    const limiter = new RateLimiter();
    expect(limiter.observe429({})).toBeGreaterThanOrEqual(1000);
    expect(limiter.observe429({ "retry-after": "not-a-number" })).toBeGreaterThanOrEqual(1000);
  });

  it("lets requests through when well inside the budget", async () => {
    const limiter = new RateLimiter();
    limiter.observeHeaders({ "x-app-rate-limit": "100:120,20:1" });
    const started = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe("external links", () => {
  const target = { gameName: "SUMMONER ONE", tagLine: "IDF", region: "NA", platformId: "NA1" };

  it("percent-encodes a Riot ID containing a space", () => {
    // A space left raw produces a silent 404 on every one of these sites.
    for (const link of buildExternalLinks(target)) {
      expect(link.url).not.toMatch(/ /);
      expect(link.url).toContain("SUMMONER%20ONE");
    }
  });

  it("gives u.gg a platform host and op.gg a region slug", () => {
    const links = buildExternalLinks(target);
    expect(links.find((l) => l.id === "ugg")?.url).toContain("/profile/na1/");
    expect(links.find((l) => l.id === "opgg")?.url).toContain("/summoners/na/");
  });

  it("does not build u.gg paths by appending 1 to the region", () => {
    // The bug this replaces: `${slug}1` yields kr1, ru1 and lan1, none of which exist.
    expect(buildUggUrl("Player", "KR1", "kr")).toContain("/profile/kr/");
    expect(buildExternalLinks({ gameName: "P", tagLine: "T", region: "LAN", platformId: "LA1" })
      .find((l) => l.id === "ugg")?.url).toContain("/profile/la1/");
    expect(buildExternalLinks({ gameName: "P", tagLine: "T", region: "RU", platformId: "RU" })
      .find((l) => l.id === "ugg")?.url).toContain("/profile/ru/");
  });

  it("returns nothing when the Riot ID is unknown", () => {
    // Better an empty section than four links that 404.
    expect(buildExternalLinks({ gameName: null, tagLine: null, region: "NA" })).toEqual([]);
  });
});
