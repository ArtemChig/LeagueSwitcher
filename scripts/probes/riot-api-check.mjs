/**
 * Riot public API probe — validates every endpoint and routing rule the app depends on.
 *
 *   node scripts/probes/riot-api-check.mjs "SUMMONER ONE#TAG1" NA
 *
 * Reads the key from %APPDATA%\LeagueSwitcher\riot-api-key.txt. Never logs it.
 * Exit code 0 = all required checks passed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const KEY_PATH = join(process.env.APPDATA, "LeagueSwitcher", "riot-api-key.txt");

/** region -> platform host (summoner-v4, league-v4) */
export const PLATFORM = {
  NA: "na1", LAN: "la1", LAS: "la2", BR: "br1", OCE: "oc1",
  EUW: "euw1", EUNE: "eun1", TR: "tr1", RU: "ru",
  KR: "kr", JP: "jp1",
  PH: "ph2", SG: "sg2", TH: "th2", TW: "tw2", VN: "vn2",
};

/** platform -> regional host (account-v1, match-v5) */
export const REGIONAL = {
  na1: "americas", br1: "americas", la1: "americas", la2: "americas",
  euw1: "europe", eun1: "europe", tr1: "europe", ru: "europe",
  kr: "asia", jp1: "asia",
  oc1: "sea", ph2: "sea", sg2: "sea", th2: "sea", tw2: "sea", vn2: "sea",
};

const key = readFileSync(KEY_PATH, "utf8").trim();
const redact = (s) => String(s).replaceAll(key, "RGAPI-<redacted>");

let pass = 0, fail = 0;
const limits = {};

async function call(host, path, { required = true, label } = {}) {
  const url = `https://${host}.api.riotgames.com${path}`;
  const res = await fetch(url, { headers: { "X-Riot-Token": key } });

  for (const h of ["x-app-rate-limit", "x-app-rate-limit-count", "retry-after"]) {
    if (res.headers.get(h)) limits[h] = res.headers.get(h);
  }

  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }

  const ok = res.status === 200;
  if (ok) pass++; else if (required) fail++;
  const mark = ok ? "PASS" : required ? "FAIL" : "warn";
  console.log(`  [${mark}] ${res.status} ${label ?? path}`);
  if (!ok && body?.status?.message) console.log(`         ${redact(body.status.message)}`);
  return { ok, status: res.status, body };
}

const [, , riotIdArg = "SUMMONER ONE#TAG1", regionArg = "NA"] = process.argv;
const [gameName, tagLine] = riotIdArg.split("#");
const platform = PLATFORM[regionArg.toUpperCase()];
const regional = REGIONAL[platform];

console.log(`\nRiot API probe — ${riotIdArg} (${regionArg} -> ${platform} / ${regional})\n`);

console.log("1. account-v1 (regional routing)");
const acct = await call(
  regional,
  `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
  { label: "by-riot-id" }
);
const puuid = acct.body?.puuid;
if (!puuid) {
  console.error("\nCannot continue without a puuid.\n");
  process.exit(1);
}
console.log(`         puuid ${puuid.slice(0, 12)}... gameName="${acct.body.gameName}" tag="${acct.body.tagLine}"`);

await call(regional, `/riot/account/v1/accounts/by-puuid/${puuid}`, { label: "by-puuid (rename detection)" });

console.log("\n2. summoner-v4 (platform routing)");
const summ = await call(platform, `/lol/summoner/v4/summoners/by-puuid/${puuid}`, { label: "by-puuid" });
if (summ.ok) console.log(`         level ${summ.body.summonerLevel}  icon ${summ.body.profileIconId}`);

console.log("\n3. league-v4 (platform routing)");
const lg = await call(platform, `/lol/league/v4/entries/by-puuid/${puuid}`, { label: "entries/by-puuid" });
if (lg.ok) {
  if (!lg.body.length) console.log("         unranked (empty array — must render as Unranked, not an error)");
  for (const e of lg.body) {
    console.log(`         ${e.queueType}: ${e.tier} ${e.rank} ${e.leaguePoints}LP  ${e.wins}W/${e.losses}L`
      + `${e.hotStreak ? "  hotStreak" : ""}${e.freshBlood ? "  freshBlood" : ""}`);
  }
}

console.log("\n4. match-v5 (regional routing)");
const ids = await call(regional, `/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=5`, { label: "match ids" });
if (ids.ok && ids.body.length) {
  const m = await call(regional, `/lol/match/v5/matches/${ids.body[0]}`, { label: "match detail" });
  if (m.ok) {
    const me = m.body.info.participants.find((p) => p.puuid === puuid);
    if (me) console.log(`         last game: ${me.championName} ${me.win ? "WIN" : "LOSS"} `
      + `${me.kills}/${me.deaths}/${me.assists}  ${m.body.info.gameMode}`);
  }
} else if (ids.ok) {
  console.log("         no matches returned (new account) — UI must handle an empty list");
}

console.log("\n5. Deprecated endpoint (must fail — proves we are not relying on it)");
const summId = summ.body?.id;
if (summId) {
  const dep = await call(platform, `/lol/league/v4/entries/by-summoner/${summId}`, {
    required: false, label: "entries/by-summoner (expected gone)",
  });
  console.log(dep.ok
    ? "         still alive, but do NOT use it — Riot removed these in June 2025"
    : "         confirmed removed, as expected");
} else {
  console.log("  [warn] summoner-v4 no longer returns `id` — summonerId is fully retired");
}

console.log("\n6. Data Dragon (no key required)");
const ver = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json();
console.log(`  [PASS] latest version ${ver[0]}`);
const iconUrl = `https://ddragon.leagueoflegends.com/cdn/${ver[0]}/img/profileicon/${summ.body?.profileIconId ?? 29}.png`;
const iconRes = await fetch(iconUrl, { method: "HEAD" });
console.log(`  [${iconRes.ok ? "PASS" : "FAIL"}] profile icon ${iconRes.status} ${iconUrl.split("/cdn/")[1]}`);
iconRes.ok ? pass++ : fail++;

console.log("\n7. Rate limit headers (drives the token bucket)");
for (const [k, v] of Object.entries(limits)) console.log(`         ${k}: ${v}`);
if (!limits["x-app-rate-limit"]) console.log("         none seen — limiter must fall back to 20/s, 100/2min");

console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : "FAILURES PRESENT"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
