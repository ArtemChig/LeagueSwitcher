# Research Findings — verified live on this machine (2026-08-31)

Everything below was **probed against the actual running Riot Client / League Client on this PC**,
not recalled from memory. Treat as ground truth; re-verify only if a call fails at runtime.

Machine baseline: Node v26.3.0, npm 11.16.0, Python 3.13.14, .NET 8.0.422.
Riot install root: `C:\Riot Games`. Riot Client data: `%LOCALAPPDATA%\Riot Games\Riot Client`.

---

## 1. The session file (the single most important discovery)

`%LOCALAPPDATA%\Riot Games\Riot Client\Data\RiotGamesPrivateSettings.yaml` (~3.7 KB)

Structure (values redacted):

```yaml
psl:
  authorization:
    riot-client:
      claims: []
      id_token: <~1279 chars>
      is_dpop_bound: false                      # NOT device-bound. Portable.
      last_token_creation_time: 1788163600123
      max_duration_between_restores: 39169575   # ~453 days
      original_token_creation_time: 1788063614594
      refresh_token: <~1335 chars>
      refresh_token_write_count: 32
      refresh_tokens_session_id: <38 chars>
      scopes: [openid, link, ban, lol_region, lol, account]
riot-login:
  persist: null
rso-authenticator:
  tdid:                                          # trusted-device cookie
    domain: riotgames.com
    expiryTime: 1819599615
    httpOnly: true
    secureOnly: true
    persistent: true
    value: <197 chars>
```

**Implications:**

- Riot no longer stores `ssid`/`clid` cookies here. It is a **long-lived OAuth refresh token**.
- `is_dpop_bound: false` means the token is **not cryptographically bound to the device**, so the
  file can be saved and restored freely. This is what makes the whole app possible.
- `max_duration_between_restores` is ~453 days. A captured session stays valid for a very long time
  as long as it is periodically restored. Sessions do not expire in days or weeks.
- Therefore: **capture once per account, switch forever, no password needed at switch time.**

`tdid` is the remembered-device cookie — carrying it per account is what suppresses repeated
2FA / email challenges after the first login.

---

## 2. Riot Client local API — confirmed available

Lockfile: `%LOCALAPPDATA%\Riot Games\Riot Client\Config\lockfile`
Format: `Riot Client:<pid>:<port>:<password>:https` (observed `Riot Client:13172:58211:<22 chars>:https`)
Auth: HTTP Basic, username `riot`, password = 4th lockfile field. TLS is self-signed, so cert
verification must be disabled (or pin Riot's `riotgames.pem`).

The full spec is served live at `GET /swagger/v3/openapi.json` — **789 paths, ~1.4 MB**. Re-pull it
any time the client updates; it is the authoritative, self-documenting source.

### Confirmed auth endpoints (present on the current client build)

| Endpoint | Method | Purpose |
|---|---|---|
| `/rso-authenticator/v1/authentication/riot-identity/start` | POST | begin password login |
| `/rso-authenticator/v1/authentication/riot-identity/complete` | POST | submit username + password |
| `/rso-authenticator/v1/authentication/multifactor` | POST | submit 2FA code |
| `/rso-auth/v1/session/login-token` | PUT | exchange login_token for a session |
| `/rso-auth/v1/session/credentials` | PUT | **legacy** direct user/pass login |
| `/rso-auth/v1/session` | GET / DELETE | read session state / log out |
| `/rso-auth/v1/authorization/refresh-token` | GET / **PUT** | read **and inject** a refresh token |
| `/rso-auth/v1/auth-hints/hint` | GET/POST/DELETE | prefill the username field in the client UI |
| `/riotclient/region-locale` | GET / PUT | read/set region and locale at runtime |
| `/player-session-lifecycle/v1/session` | GET/POST/PUT/DELETE | high-level session lifecycle |
| `/entitlements/v1/token`, `/entitlements/v2/token` | GET | entitlements JWT |

### Exact schemas

`POST /rso-authenticator/v1/authentication/riot-identity/start`

```
req: { language, productId, state }
```

`POST /rso-authenticator/v1/authentication/riot-identity/complete`

```
req: { username, password, remember, language, captcha, campaign }
res: { type: 'auth' | 'ambiguous_auth' | 'healup' | 'kr-id-verification' | 'ambiguous_username'
             | 'signup' | 'multifactor' | 'gamepass' | 'confirm_age' | 'success' | 'error',
       success: { login_token, puuid, auth_method, remember, linked, redirect_url,
                  is_console_link_session },
       multifactor: { method, methods[], email, known_value, mode, auth_method },
       captcha: { type: 'none' | 'hcaptcha', hcaptcha: { key, data } },
       validation_captcha: { ... },
       error, retryAfter, country, cluster, suuid, timestamp }
```

`POST /rso-authenticator/v1/authentication/multifactor`

```
req: { multifactor: { otp, method, rememberDevice, action } }
```

`PUT /rso-auth/v1/session/login-token`

```
req: { authentication_type: 'RiotAuth' | 'SSOAuth' | 'None', login_token, persist_login, code_verifier }
res: { type: 'authenticated' | 'needs_credentials' | 'needs_password'
             | 'needs_multifactor_verification' | 'error' | 'unknown_authentication_response',
       authenticationType, persistLogin, country, securityProfile, multifactor{...}, error }
```

`PUT /rso-auth/v1/session/credentials` (legacy — **no captcha field in the schema**)

```
req: { username, password, region, persistLogin }
res: same shape as the login-token response above
```

`PUT /rso-auth/v1/authorization/refresh-token` — **hot-swap candidate**

```
req: { refresh_token, id_token, is_dpop_bound, permissions[] }
res: { type: 'authorized' | 'needs_authentication' | 'needs_reauthentication' | 'refresh_failed' | ...,
       authorization: { accessToken, idToken, isDPoPBound }, deletionReason, country }
```

`GET /riotclient/region-locale` returns `{ locale: "en_US", region: "NA", webLanguage: "en", webRegion: "na" }`

---

## 3. hCaptcha — the main constraint on password automation

The captcha schema is real and wired into the login flow:
`{ type: 'none' | 'hcaptcha', hcaptcha: { key, data } }` where `key` is the sitekey and `data` is rqdata.

Evidence from this machine's own Riot Client logs (`.../Riot Client/Logs/`):

```
telemetry: Sending telemetry to schema riotclient__CaptchaEvent__v6 with:
  {"action":"succeeded","riotclientMetadata":{"riotclientURL":"/login"},"type":"hcaptcha"}
```

This fires on **every real login** on this PC. Config also shows `"hcaptcha_bypass_token": null`.

**Conclusion:** the modern `riot-identity` password flow will return a captcha challenge that a
headless client cannot solve without an external solver. Solving hCaptcha is explicitly out of
scope — unreliable, paid, and a permanent cat-and-mouse dependency.

**This is why the architecture is session-capture-first, not password-first.** Passwords are stored
and used only for one-time enrollment (and re-enrollment if a session is ever invalidated), where
the user is present to click the captcha if it appears.

The `type` enum includes `'none'`, so captcha is server-side risk-driven and may be skipped for
trusted devices — which is exactly what the `tdid` cookie buys us. The legacy
`/rso-auth/v1/session/credentials` endpoint has **no captcha field at all**, so it may still work
without one. Worth a definitive test — see PLAN Phase 0, EXP-3.

---

## 4. League Client (LCU) — data enrichment, no API key needed

Lockfile: `C:\Riot Games\League of Legends\lockfile` → `LeagueClient:<pid>:<port>:<pw>:https`
(observed `LeagueClient:35020:55472:...`). Same Basic `riot:<pw>` auth.

**Live-verified responses on the currently logged-in account:**

`GET /lol-summoner/v1/current-summoner`

```json
{ "gameName": "SUMMONER ONE", "tagLine": "IDF", "summonerLevel": 33,
  "profileIconId": 29, "summonerId": <summoner-id>, "accountId": <summoner-id>,
  "puuid": "<redacted>", "xpSinceLastLevel": 1333, "xpUntilNextLevel": 2784,
  "percentCompleteForNextLevel": 47, "privacy": "PUBLIC", "nameChangeFlag": false }
```

`GET /lol-ranked/v1/current-ranked-stats` top-level keys:
`currentSeasonSplitPoints, earnedRegaliaRewardIds, highestCurrentSeasonReachedTierSR,
highestPreviousSeasonEndDivision, highestPreviousSeasonEndTier, highestRankedEntry,
highestRankedEntrySR, previousSeasonSplitPoints, queueMap, queues, rankedRegaliaLevel, seasons`

`queueMap.RANKED_SOLO_5x5` → `{ tier: "BRONZE", division: "I", leaguePoints: 5, wins: 13,
losses: 10, previousSeasonEndTier: "" }` — exactly the data needed for the account cards.

Other useful LCU endpoints to wire up. Verify each at build time against `/swagger/v3/openapi.json`
on the LCU port (or `/help`), since LCU paths churn between patches:

- `/lol-inventory/v1/wallet/lol_blue_essence` and `.../RP` — BE / RP balances
- `/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=20` — recent games
- `/lol-collections/v1/inventories/{summonerId}/champion-mastery-score` — mastery score
- `/lol-honor-v2/v1/profile` — honor level
- `/lol-champions/v1/owned-champions-minimal` — champion count
- `/lol-loot/v1/player-loot` — loot and chests
- `/lol-chat/v1/me` — status and availability
- `/lol-login/v1/session` — login state and account restrictions
- `/lol-leaver-buster/v1/notifications`, `/lol-penalty-notification/*` — active bans / penalties

---

## 5. Region configuration

`%LOCALAPPDATA%\Riot Games\Riot Client\Config\RiotClientSettings.yaml`:

```yaml
install:
  globals:
    locale: "en_US"
    region: "NA"
  localization:
    locale: "en_US"
    region: "NA"
  player-affinity:
    product: { bacon: {live: americas}, lion: {live: am}, valorant: {live: na, pbe: na} }
    service: { chat: eu, mailbox: eu, rms: eu, report-collector: eu, discipline-tokenservice: eu }
```

Region for LoL is driven by `install.globals.region` plus the runtime `PUT /riotclient/region-locale`.
The refresh token also carries the account shard (`lol_region` scope), so region may follow the
session automatically. **EXP-4 must confirm** whether an explicit region write is needed when
switching between e.g. NA and EUW.

Per-product metadata lives in
`C:\ProgramData\Riot Games\Metadata\<product>.<patchline>\<product>.<patchline>.product_settings.yaml`
(locale only — no account data).

---

## 6. Launching and process management

`RiotClientServices.exe --launch-product=league_of_legends --launch-patchline=live`
(`--launch-patchline=pbe` for PBE; `teamfighttactics` or `valorant` for other products).
Path: `C:\Riot Games\Riot Client\RiotClientServices.exe`.

Processes observed running that must be terminated before a cold swap:
`LeagueClient.exe`, `LeagueClientUx.exe`, `LeagueClientUxRender.exe`, `LeagueCrashHandler64.exe`,
`RiotClientServices.exe`, `Riot Client.exe` (about six Electron helpers), `RiotClientCrashHandler.exe`,
`RiotClientUx.exe`, `RiotClientUxRender.exe`.

---

## 7. Phase 0 experiment outcomes — run 2026-08-31, 10:14–10:28

All of the below were **executed on this machine**, not reasoned about. Raw responses are in
`%APPDATA%\LeagueSwitcher\probe-results\*.json`; the probes that produced them are in
`scripts/probes/`. Re-run any of them with `node scripts/probes/<name>.mjs`.

| ID | Question | Outcome |
|---|---|---|
| EXP-1 | Does cold file-swap plus relaunch auto-login? | ✅ **PASS** — and fast |
| EXP-2 | Does `PUT /rso-auth/v1/authorization/refresh-token` hot-swap? | ❌ **FAIL** — route 404s at runtime |
| EXP-3 | Does legacy `PUT /rso-auth/v1/session/credentials` still work? | ⚠️ **Route present**, full test blocked (no credential) |
| EXP-4 | Does region follow the session? | ⚠️ **Strong evidence yes**, needs a 2nd region to confirm |
| EXP-5 | Does restoring a session rotate the token? | ✅ **Answered** — `id_token` rotates, `refresh_token` does not |
| EXP-6 | Minimum process kill set? | ✅ **One process** — `RiotClientServices` |
| EXP-7 | Launch the client with no product? | ✅ **PASS** — no args, League never starts |

### EXP-1 — cold session swap round-trip ✅ THE GATE

Sequence run: capture → kill → **wipe → launch → confirm NOT signed in** → kill → restore →
launch → poll. The negative control is the part that makes the result mean anything: without it
the test cannot distinguish "the restore worked" from "the session was never gone".

```
wiped session (59 bytes, no refresh_token):
    loginState = PendingLoginStrategy,  authenticated = false      <- correct
restored session (3704 bytes):
    rso = 200/authenticated,  loginState = PendingProductContext   <- correct
    elapsed: ~2.1 s from launch to authenticated
    signed in as SUMMONER ONE#TAG1, country usa
```

**The core mechanism of the entire app is confirmed on this machine.** A switch is a file copy
plus a relaunch, and it is *much* faster than the 10–15 s the plan budgeted.

Also observed: **the client does not rewrite the session file on exit** (sha256 unchanged across
a kill). Restoring after the processes are confirmed dead is still the correct order, but there is
no shutdown-write race to lose to.

### EXP-2 — hot refresh-token injection ❌ FAIL

`PUT /rso-auth/v1/authorization/refresh-token` was tested in **both** client states:

| Client state | Response |
|---|---|
| signed out (wiped session, `PendingLoginStrategy`) | `404 RPC_ERROR "Not Found"` |
| signed in (`200/authenticated`, RSO initialised) | `404 RPC_ERROR "Not Found"` |

`GET` on the same path also 404s. The path **is** in the spec, with a full request/response schema
and the summary *"Restore a player's refresh token along with an id token to refill some claims
for the authorization"* — but it is not implemented on this build.

> ### ⚠️ The spec is a SUPERSET of what is implemented
>
> This is the important generalisation, and it modifies hard rule 6. Checking
> `/swagger/v3/openapi.json` is **necessary but not sufficient** — a path can be fully documented
> there and still answer `404 RPC_ERROR "Not Found"`. Every endpoint this app depends on must be
> probed at runtime, not merely found in the spec. `scripts/probes/swagger-dump.mjs` checks
> presence; only an actual call checks reality.

**Consequence:** S2 is dead on this client build. **S1 cold swap is the switch path.** Since EXP-1
switches in ~2 s anyway, the speed argument for S2 has largely evaporated. Keep the setting, keep
it off by default, and re-probe after client updates.

### EXP-3 — legacy credentials endpoint ⚠️ route present, full test BLOCKED

`test-credentials.json` no longer exists on this machine, so the real test could not run and
**P0.6 is BLOCKED**. Reachability was settled at zero cost instead: a single request carrying
**empty strings** — naming no account, so spending no account's 2-attempt budget:

```
PUT /rso-auth/v1/session/credentials  { username: "", password: "", region: "", persistLogin: false }
-> 400 RPC_ERROR "No previous RSO session found"
```

`400`, not `404`. Unlike EXP-2's route, **this one is implemented**. Note the error is about a
missing *RSO session*, not about the missing username — so the endpoint likely expects a login
flow to have been started first, rather than being a standalone one-shot login.

S3b therefore remains a live candidate for headless enrolment. Settling it needs exactly one real
credential and one attempt, under hard rule 9.

### EXP-4 — does region follow the session? ⚠️ strong evidence, not conclusive

Not directly testable: only one account is enrolled and it is NA. But the signed-in client hands
over its own region without being asked, from `/player-session-lifecycle/v1/session` → `userInfo`:

```
region      : { id: "NA1", locales: ["en_US"], tag: "na" }
lol         : { cpid: "NA1", pid: "NA1", ploc: "en-US", active: true }
lol_region  : [ { cpid: "NA1", pid: "NA1", active: true } ]
affinity    : { pp: "am" }
original_platform_id : "NA1"
```

The platform ID is carried **inside the session's own claims**, consistent with the `lol_region`
scope on the refresh token. So region travels with the session, and `install.globals.region`
should not need rewriting.

**Assumed default for the build (the plan's documented fallback): do not write the region file.**
Read the platform from `userInfo.region.id` after the switch instead. Confirm with an EUW/LAN
account in the morning — see "Needs morning verification".

### EXP-5 — token rotation on restore ✅ answered

Measured across four capture → restore → relaunch cycles:

| Field | Behaviour |
|---|---|
| `refresh_token` | **unchanged** (same fingerprint across all four cycles) |
| `id_token` | **rotates every time** |
| `refresh_token_write_count` | **+1 per cycle** (34 → 35 → 36 → 38) |
| `last_token_creation_time` | updated to the moment of sign-in |
| `original_token_creation_time` | stable |
| `tdid` | unchanged |

The thing that actually authenticates — the `refresh_token` — is **stable**, so a stored copy does
not rot after one use. But the file around it changes on every sign-in, so the app should still
**re-capture after each switch** to keep `id_token` and `write_count` in step with the server.
That is a freshness measure, not a correctness one: a stale capture still logged in every time.

### EXP-6 — minimum kill set ✅ one process

With the client up (8 processes: 6 `Riot Client` Electron helpers, `RiotClientCrashHandler`,
`RiotClientServices`), stopping **`RiotClientServices` alone** left **nothing** behind within 4 s.
The helpers are children and exit with the parent.

**Minimum kill set: `RiotClientServices`.** ⚠️ Measured with League *not* running — `LeagueClient*`
is a separate process tree and must still be swept when it is up.

### EXP-7 — launch with no product ✅ PASS

`RiotClientServices.exe` with **no arguments at all** brings the client up and signs it in. Across
five launches during EXP-1/2/6, **no `LeagueClient*` process and no LCU lockfile ever appeared.**
League is never started, which is exactly what the plan requires of a switch.

### Bonus finding — the client identifies the account itself, with no API key

`GET /player-session-lifecycle/v1/session` on a signed-in client returns, with no API key and
without launching League:

| Field | Value observed | Feeds |
|---|---|---|
| `riotID` | `{ gameName: "SUMMONER ONE", tagLine: "IDF" }` | the card's hero line, and §4.2's durable identifier |
| `userInfo.preferred_username` | `accountOne` | the login-username line on the card |
| `userInfo.region.id` | `NA1` | region badge, platform routing |
| `userInfo.lol_account.summoner_level` | `33` | the level pip |
| `userInfo.lol_account.profile_icon` | `29` | the avatar |
| `country`, `loginCountry` | `usa` | — |
| `loginState` | `PendingProductContext` when signed in, `PendingLoginStrategy` when not | switch progress UI |

Three things follow:

1. **Enrolment no longer needs the LCU.** §4 above has the Riot ID coming from
   `/lol-summoner/v1/current-summoner`, which requires League to be running. The Riot Client gives
   the same answer at switch time. The LCU drops to what §4.5 already calls it — a source of
   extras (BE/RP, loot, honour), never a dependency.
2. **The grid degrades well without an API key.** Riot ID, login username, region, level and
   profile icon all come from the local client. Only rank and match history need the public API,
   so a missing key costs two fields, not the screen.
3. **`preferred_username` closes a gap the ledger flagged.** It maps a login username to a Riot ID
   automatically at enrolment, so the user never has to type a Riot ID by hand. On this machine it
   resolved test account `accountOne` → `SUMMONER ONE#TAG1` (NA1).

### Readiness signalling — `/rso-auth/v1/session` 404 is a STATE, not an error

Before the client finishes booting, `GET /rso-auth/v1/session` answers
`404 RPC_ERROR "RSO is not yet initialized"`. That is not a missing route and not a failure — it
means "still starting". Treating it as failure is what made the first EXP-1 run report a false FAIL.

Poll **both** endpoints when waiting for a switch to land:

- `/player-session-lifecycle/v1/session` — answers 200 from the moment the client is up, and its
  `loginState` separates "still booting" from "booted, sitting at the login screen"
- `/rso-auth/v1/session` — the authoritative `type == "authenticated"` once RSO is initialised

`readLoginState()` in `scripts/probes/lib/riotlocal.mjs` implements exactly this and is the
reference for the Phase 1 port.

---

## 8. Prior art

Existing open-source switchers, all of which converge on the file-swap approach — useful as
reference if a mechanism misbehaves:

- [TCNOco/TcNo-Acc-Switcher](https://github.com/TCNOco/TcNo-Acc-Switcher) — multi-platform, C#, mature
- [arthiee4/RiotSwitcher](https://github.com/arthiee4/RiotSwitcher) — captures local credentials, copies profile into the client folder
- [RevenzMind/RiotSwitch](https://github.com/RevenzMind/RiotSwitch) — cookie/session based
- GitHub topics: [`lol-account-switcher`](https://github.com/topics/lol-account-switcher), [`account-switcher`](https://github.com/topics/account-switcher)

---

## 9. Public Riot API — verified 2026-08-31 with the permanent personal key

Personal key approved instantly (App ID <app-id>, no expiry). Full probe:
`node scripts/probes/riot-api-check.mjs "SUMMONER ONE#TAG1" NA` — all checks pass.

### ⚠️ PUUIDs are encrypted per API key

The single most important finding. Same account, same endpoint, different key:

```
personal key  ->  <puuid-key-A>
dev key       ->  <puuid-key-B>
```

A puuid is only meaningful to the key that issued it. Therefore:

- The local Riot Client's `success.puuid` and the LCU's `current-summoner.puuid` are **useless
  against the public API**.
- **Riot ID (`gameName` + `tagLine`) is the durable cross-boundary identifier.**
- Cache each puuid with a fingerprint of the key that produced it; invalidate on key change.

### summonerId is fully retired

`summoner-v4/by-puuid` no longer returns an `id` field at all — not deprecated, *gone*. Every
`by-summoner` endpoint is unusable. Everything must be puuid-keyed.

### Verified responses

| Endpoint | Host | Result |
|---|---|---|
| `account-v1/accounts/by-riot-id/{name}/{tag}` | `americas` | 200 — puuid, gameName, tagLine |
| `account-v1/accounts/by-puuid/{puuid}` | `americas` | 200 — rename detection |
| `summoner-v4/summoners/by-puuid/{puuid}` | `na1` | 200 — level 33, icon 29, no `id` |
| `league-v4/entries/by-puuid/{puuid}` | `na1` | 200 — BRONZE I, 5 LP, 13W/10L, freshBlood |
| `match-v5/matches/by-puuid/{puuid}/ids` | `americas` | 200 |
| `match-v5/matches/{matchId}` | `americas` | 200 — Katarina, WIN, 20/2/3, CLASSIC |

An unranked account returns `[]` from league-v4 — **render as Unranked, not as an error**.
A new account returns `[]` from match-v5 ids — the UI must handle an empty match list.

### Rate limit headers (drive the token bucket)

```
x-app-rate-limit:       100:120,20:1     -> 100 per 120s, 20 per 1s
x-app-rate-limit-count:   4:120,4:1      -> current usage in each window
```

Parse these rather than hardcoding; honour `retry-after` on 429.

### Data Dragon

Latest version `16.17.1` (pin from `https://ddragon.leagueoflegends.com/api/versions.json` -> `[0]`).
Profile icon URL confirmed 200:
`https://ddragon.leagueoflegends.com/cdn/16.17.1/img/profileicon/29.png`

### Rank crest assets

Community Dragon mini-crest SVGs, 0.9-2.3 KB each, official colours baked in.
**`diamond.svg` ships mis-tinted purple (`#8141EB`)** — nearly identical to Master. Sampling
`emblem-diamond.png` confirms the real emblem is blue (hue 225-240 deg). Patch that one fill to
`#4C6FD9` on download. All other tiers verified correct against their emblems.
