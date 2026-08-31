/**
 * Shared helpers for the Phase 0 probes: lockfiles, the two local HTTPS APIs,
 * process control, and session-file capture/restore.
 *
 * Dependency-free and standalone so every experiment runs with a bare
 * `node scripts/probes/<exp>.mjs`. Phase 1 ports this logic into src/main/riot/ —
 * keep the two in step.
 *
 * SAFETY: nothing here ever prints a lockfile password, refresh token or id_token.
 * Everything that touches those goes through redact() / summariseSession().
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { request } from "node:https";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------- paths

export const LOCALAPPDATA = process.env.LOCALAPPDATA;
export const APPDATA = process.env.APPDATA;
export const RIOT_INSTALL = "C:\\Riot Games";

export const PATHS = {
  rcLockfile: join(LOCALAPPDATA, "Riot Games", "Riot Client", "Config", "lockfile"),
  lcuLockfile: join(RIOT_INSTALL, "League of Legends", "lockfile"),
  rcSession: join(LOCALAPPDATA, "Riot Games", "Riot Client", "Data", "RiotGamesPrivateSettings.yaml"),
  rcSettings: join(LOCALAPPDATA, "Riot Games", "Riot Client", "Config", "RiotClientSettings.yaml"),
  lolSession: join(LOCALAPPDATA, "Riot Games", "League of Legends", "Data", "RiotGamesPrivateSettings.yaml"),
  rcServices: join(RIOT_INSTALL, "Riot Client", "RiotClientServices.exe"),
  appRoot: join(APPDATA, "LeagueSwitcher"),
  backups: join(APPDATA, "LeagueSwitcher", "backups"),
  probeOut: join(APPDATA, "LeagueSwitcher", "probe-results"),
};

// ---------------------------------------------------------------- redaction

/** Secrets registered here are scrubbed from every log line this process emits. */
const SECRETS = new Set();
export function registerSecret(s) {
  if (typeof s === "string" && s.length >= 8) SECRETS.add(s);
}
export function redact(value) {
  let s = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
  for (const secret of SECRETS) s = s.split(secret).join("<redacted>");
  // Belt and braces: anything JWT-shaped or key-shaped goes too.
  s = s.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, "<jwt:redacted>");
  s = s.replace(/RGAPI-[0-9a-fA-F-]{20,}/g, "RGAPI-<redacted>");
  return s;
}
export function log(...parts) {
  console.log(parts.map((p) => redact(p)).join(" "));
}
/** SHA256 prefix — lets us compare two secrets without ever showing either. */
export function fingerprint(s) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------- lockfiles

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check, no signal delivered
    return true;
  } catch (err) {
    if (err.code === "EPERM") return true; // exists, we just cannot signal it
    return false;
  }
}

/**
 * Parse `name:pid:port:password:protocol`. Returns null when absent, and sets
 * `stale` when the file exists but its PID is dead — the lockfile observed on this
 * machine was two days stale, so this check is mandatory, not defensive.
 */
export function readLockfile(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  const parts = raw.split(":");
  if (parts.length < 5) {
    return { path, malformed: true, raw: `<${raw.length} chars, ${parts.length} fields>` };
  }
  const [name, pid, port, password, protocol] = parts;
  registerSecret(password);
  const lock = {
    path,
    name,
    pid: Number(pid),
    port: Number(port),
    password,
    protocol,
    mtime: statSync(path).mtime.toISOString(),
  };
  lock.stale = !isPidAlive(lock.pid);
  return lock;
}

export const readRcLockfile = () => readLockfile(PATHS.rcLockfile);
export const readLcuLockfile = () => readLockfile(PATHS.lcuLockfile);

/** Safe one-line description — never includes the password. */
export function describeLock(lock) {
  if (!lock) return "absent";
  if (lock.malformed) return `malformed (${lock.raw})`;
  return `${lock.name} pid=${lock.pid} port=${lock.port} ` +
    `${lock.stale ? "STALE (pid dead)" : "live"} mtime=${lock.mtime}`;
}

// ---------------------------------------------------------------- local HTTPS client

/**
 * Call a Riot local API. TLS is self-signed on both the Riot Client and the LCU, so
 * verification is disabled for these loopback ports only — never globally.
 */
export function localApi(lock, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host: "127.0.0.1",
        port: lock.port,
        path,
        method,
        rejectUnauthorized: false,
        headers: {
          Authorization: "Basic " + Buffer.from(`riot:${lock.password}`).toString("base64"),
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout after 15s")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------- processes

export const RIOT_PROCESS_NAMES = [
  "LeagueClient", "LeagueClientUx", "LeagueClientUxRender", "LeagueCrashHandler64",
  "RiotClientServices", "Riot Client", "RiotClientCrashHandler",
  "RiotClientUx", "RiotClientUxRender",
];
/** A game actually in progress. Switching here is refused outright — PLAN §3 S1. */
export const GAME_PROCESS_NAME = "League of Legends";

function powershell(script) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
}

function nameArray(names) {
  return "@(" + names.map((n) => "'" + n.replace(/'/g, "''") + "'").join(",") + ")";
}

/**
 * NOTE: deliberately line-oriented rather than ConvertTo-Json. Windows PowerShell 5.1
 * serialises `,@($x)` as {"value":[...],"Count":n} rather than a bare array, which
 * silently made this function return "nothing is running" while the client was up.
 * Plain text has no such surprises.
 */
export function listRiotProcesses() {
  const names = nameArray(RIOT_PROCESS_NAMES.concat(GAME_PROCESS_NAME));
  const script =
    "$names = " + names + "; " +
    "Get-Process -ErrorAction SilentlyContinue | " +
    "Where-Object { $names -contains $_.Name } | " +
    "ForEach-Object { \"$($_.Id)|$($_.Name)\" }";
  const out = powershell(script).trim();
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, ...rest] = line.split("|");
      return { Id: Number(id), Name: rest.join("|") };
    })
    .filter((p) => Number.isInteger(p.Id) && p.Name);
}

export function isGameRunning() {
  return listRiotProcesses().some((p) => p.Name === GAME_PROCESS_NAME);
}

/** Graceful CloseMainWindow, then force. Returns what it stopped and what survived. */
export function killRiotProcesses({ only = null, graceMs = 3000 } = {}) {
  const targets = only ?? RIOT_PROCESS_NAMES;
  const before = listRiotProcesses().filter((p) => targets.includes(p.Name));
  if (before.length === 0) return { stopped: [], survivors: [], alreadyClear: true };

  const script =
    "$names = " + nameArray(targets) + "; " +
    "$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.Name }; " +
    "foreach ($p in $procs) { try { $null = $p.CloseMainWindow() } catch {} } " +
    "Start-Sleep -Milliseconds " + graceMs + "; " +
    "$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.Name }; " +
    "foreach ($p in $procs) { try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch {} } " +
    "Start-Sleep -Milliseconds 800";
  powershell(script);

  const after = listRiotProcesses().filter((p) => targets.includes(p.Name));
  return {
    stopped: before.map((p) => `${p.Name}#${p.Id}`),
    survivors: after.map((p) => `${p.Name}#${p.Id}`),
    alreadyClear: false,
  };
}

/**
 * Launch the Riot Client. `product` is deliberately optional and defaults to NOTHING:
 * PLAN §8 — a switch launches the Riot Client only and never starts League.
 */
export function launchRiotClient({ product = null, patchline = "live", extraArgs = [] } = {}) {
  if (!existsSync(PATHS.rcServices)) {
    throw new Error(`RiotClientServices.exe not found at ${PATHS.rcServices}`);
  }
  const args = [];
  if (product) args.push(`--launch-product=${product}`, `--launch-patchline=${patchline}`);
  args.push(...extraArgs);
  const child = spawn(PATHS.rcServices, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  return { exe: PATHS.rcServices, args };
}

// ---------------------------------------------------------------- session file

/**
 * Pull the interesting scalars out of RiotGamesPrivateSettings.yaml without a YAML
 * dependency. Token VALUES are reduced to a length + fingerprint and never returned
 * in full, so a summary is always safe to print or serialise.
 */
export function summariseSession(path = PATHS.rcSession) {
  if (!existsSync(path)) return { present: false, path };
  const raw = readFileSync(path, "utf8");
  const scalar = (key) => {
    const m = raw.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m"));
    return m ? m[1].replace(/^"|"$/g, "") : null;
  };
  const token = (key) => {
    const v = scalar(key);
    if (!v || v === "null" || v === "[]") return null;
    registerSecret(v);
    return { length: v.length, fp: fingerprint(v) };
  };
  return {
    present: true,
    path,
    bytes: Buffer.byteLength(raw),
    sha256: createHash("sha256").update(raw).digest("hex"),
    mtime: statSync(path).mtime.toISOString(),
    refreshToken: token("refresh_token"),
    idToken: token("id_token"),
    tdid: token("value"),
    refreshTokenWriteCount: Number(scalar("refresh_token_write_count")),
    lastTokenCreationTime: Number(scalar("last_token_creation_time")),
    originalTokenCreationTime: Number(scalar("original_token_creation_time")),
    maxDurationBetweenRestores: Number(scalar("max_duration_between_restores")),
    isDpopBound: scalar("is_dpop_bound") === "true",
    sessionId: token("refresh_tokens_session_id"),
    hasAuthorization: /refresh_token:\s*\S/.test(raw),
  };
}

/**
 * Extract the token VALUES from a session file, for injection via
 * PUT /rso-auth/v1/authorization/refresh-token.
 *
 * Every value returned is registered with the redactor first, so even an accidental
 * console.log of the result comes out as <redacted>. Callers must still never persist it.
 */
export function readSessionSecrets(path = PATHS.rcSession) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const pick = (key) => {
    const m = raw.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m"));
    if (!m) return null;
    const v = m[1].replace(/^"|"$/g, "");
    if (!v || v === "null") return null;
    registerSecret(v);
    return v;
  };
  return {
    refreshToken: pick("refresh_token"),
    idToken: pick("id_token"),
    isDpopBound: /is_dpop_bound:\s*true/.test(raw),
  };
}

/** Raw contents — for capture/restore only. Never log the return value. */
export function readSessionRaw(path = PATHS.rcSession) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function captureSession(destFile, path = PATHS.rcSession) {
  if (!existsSync(path)) throw new Error(`no session file at ${path}`);
  mkdirSync(dirname(destFile), { recursive: true });
  copyFileSync(path, destFile);
  return summariseSession(path);
}

export function restoreSession(srcFile, path = PATHS.rcSession) {
  if (!existsSync(srcFile)) throw new Error(`no captured session at ${srcFile}`);
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(srcFile, path);
  return summariseSession(path);
}

// ---------------------------------------------------------------- polling

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for the Riot Client lockfile to appear with a live PID. */
export async function waitForRcLockfile(timeoutMs = 90000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = readRcLockfile();
    if (lock && !lock.malformed && !lock.stale) return lock;
    await sleep(intervalMs);
  }
  return null;
}

/**
 * One read of "is this client signed in, and as whom".
 *
 * Two sources, because neither alone is enough:
 *
 *  - `/rso-auth/v1/session` is the documented one, but before the client finishes booting
 *    it answers 404 `"RSO is not yet initialized"`. That is a *state*, not a missing route —
 *    verified against the live spec, which lists the path (see swagger-dump.mjs). Treating
 *    that 404 as failure is what made the first EXP-1 run look like a FAIL.
 *  - `/player-session-lifecycle/v1/session` answers 200 from the moment the client is up and
 *    carries `loginState`, `puuid` and `riotID`, so it distinguishes "still booting" from
 *    "booted, sitting at the login screen" — and names the account once signed in.
 */
export async function readLoginState(lock) {
  const out = { authenticated: false };

  try {
    const res = await localApi(lock, "GET", "/rso-auth/v1/session");
    out.rsoStatus = res.status;
    out.rsoType = res.json?.type ?? null;
    out.rsoInitialised = !(res.status === 404 && /not yet initialized/i.test(res.json?.message ?? ""));
    if (res.json?.type === "authenticated") out.authenticated = true;
  } catch (err) {
    out.rsoError = err.message;
  }

  try {
    const res = await localApi(lock, "GET", "/player-session-lifecycle/v1/session");
    out.lifecycleStatus = res.status;
    if (res.json) {
      out.loginState = res.json.loginState ?? null;
      out.puuid = res.json.puuid ?? null;          // LOCAL puuid — never send to the public API
      out.riotID = res.json.riotID ?? null;
      out.country = res.json.country ?? null;
      out.hasAccessToken = Boolean(res.json.accessToken);
      out.actionRequired = res.json.actionRequired ?? null;
      // A populated puuid means RSO handed this client a real identity.
      if (out.puuid) out.authenticated = true;
    }
  } catch (err) {
    out.lifecycleError = err.message;
  }

  return out;
}

/** Poll until the client reports a signed-in session, or the timeout expires. */
export async function waitForAuthenticated(lock, timeoutMs = 90000, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  let last = null;
  while (Date.now() < deadline) {
    last = await readLoginState(lock);
    const key = JSON.stringify([last.rsoStatus, last.rsoType, last.loginState, Boolean(last.puuid)]);
    if (key !== seen.at(-1)?.key) {
      seen.push({
        key,
        at: new Date().toISOString(),
        rso: `${last.rsoStatus}${last.rsoType ? "/" + last.rsoType : ""}`,
        loginState: last.loginState,
        identified: Boolean(last.puuid),
      });
    }
    if (last.authenticated) return { ok: true, state: last, observations: seen };
    await sleep(intervalMs);
  }
  return { ok: false, state: last, observations: seen };
}

// ---------------------------------------------------------------- result recording

export function writeResult(name, data) {
  mkdirSync(PATHS.probeOut, { recursive: true });
  const file = join(PATHS.probeOut, `${name}.json`);
  const body = JSON.stringify({ recordedAt: new Date().toISOString(), ...data }, null, 2);
  writeFileSync(file, redact(body), "utf8");
  return file;
}
