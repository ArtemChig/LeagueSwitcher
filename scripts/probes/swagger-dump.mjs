/**
 * Pull the Riot Client's live OpenAPI spec and check the endpoints this app depends on.
 * Hard rule 6: never invent an endpoint — verify it against the spec the running client serves.
 *
 *   node scripts/probes/swagger-dump.mjs            # summary + dependency check
 *   node scripts/probes/swagger-dump.mjs rso-auth   # also list every path matching a filter
 *
 * Writes the full spec to %APPDATA%\LeagueSwitcher\probe-results\openapi-riotclient.json
 * so later probes can grep it offline.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PATHS, describeLock, localApi, log, readRcLockfile, writeResult } from "./lib/riotlocal.mjs";

const filter = process.argv[2] ?? null;

const lock = readRcLockfile();
if (!lock || lock.stale || lock.malformed) {
  log(`Riot Client lockfile: ${describeLock(lock)}`);
  log("Start the Riot Client first — the spec is only served by a running client.");
  process.exit(2);
}
log(`Riot Client: ${describeLock(lock)}`);

const res = await localApi(lock, "GET", "/swagger/v3/openapi.json");
if (res.status !== 200 || !res.json) {
  log(`GET /swagger/v3/openapi.json -> ${res.status}`);
  log(res.text.slice(0, 400));
  process.exit(1);
}

mkdirSync(PATHS.probeOut, { recursive: true });
const specFile = join(PATHS.probeOut, "openapi-riotclient.json");
writeFileSync(specFile, JSON.stringify(res.json, null, 2), "utf8");

const paths = Object.keys(res.json.paths ?? {});
log(`\nspec: ${paths.length} paths, ${(res.text.length / 1024 / 1024).toFixed(2)} MB -> ${specFile}`);

const methodsOf = (p) =>
  Object.keys(res.json.paths[p] ?? {})
    .filter((m) => ["get", "post", "put", "delete", "patch"].includes(m))
    .map((m) => m.toUpperCase())
    .join("/");

// Every local endpoint PLAN.md and RESEARCH.md rely on. Presence is checked, not assumed.
const REQUIRED = [
  "/rso-auth/v1/session",
  "/rso-auth/v1/session/login-token",
  "/rso-auth/v1/session/credentials",
  "/rso-auth/v1/authorization/refresh-token",
  "/rso-auth/v1/auth-hints/hint",
  "/rso-authenticator/v1/authentication/riot-identity/start",
  "/rso-authenticator/v1/authentication/riot-identity/complete",
  "/rso-authenticator/v1/authentication/multifactor",
  "/riotclient/region-locale",
  "/player-session-lifecycle/v1/session",
  "/entitlements/v1/token",
];

log("\n== dependency check ==");
const check = {};
let missing = 0;
for (const p of REQUIRED) {
  const present = paths.includes(p);
  check[p] = present ? methodsOf(p) : null;
  if (!present) missing++;
  log(`  ${present ? "OK  " : "GONE"} ${p}${present ? `  [${methodsOf(p)}]` : ""}`);
}

// For anything missing, offer the nearest surviving relatives rather than a bare "gone".
if (missing) {
  log("\n== nearest matches for the missing paths ==");
  for (const p of REQUIRED.filter((x) => !paths.includes(x))) {
    const stem = p.split("/").slice(0, 3).join("/");
    const near = paths.filter((x) => x.startsWith(stem)).slice(0, 25);
    log(`  ${p}  ->  ${near.length ? "" : "(no paths share the stem " + stem + ")"}`);
    for (const n of near) log(`      ${n}  [${methodsOf(n)}]`);
  }
}

if (filter) {
  const hits = paths.filter((p) => p.includes(filter)).sort();
  log(`\n== paths matching "${filter}" (${hits.length}) ==`);
  for (const p of hits) log(`  ${p}  [${methodsOf(p)}]`);
}

log(`\nrecorded -> ${writeResult("swagger-check", {
  probe: "swagger-dump",
  pathCount: paths.length,
  specFile,
  required: check,
  missingCount: missing,
})}`);
