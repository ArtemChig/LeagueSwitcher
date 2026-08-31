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

## 7. Open questions for Phase 0 experiments

| ID | Question | Why it matters |
|---|---|---|
| EXP-1 | Does cold file-swap plus relaunch actually auto-login? | Core mechanism |
| EXP-2 | Does `PUT /rso-auth/v1/authorization/refresh-token` hot-swap without a restart? | 15s switch becomes 2s |
| EXP-3 | Does legacy `PUT /rso-auth/v1/session/credentials` still work without captcha? | Would enable true password-only enrollment |
| EXP-4 | Does region follow the session, or must `install.globals.region` be rewritten? | Cross-region accounts |
| EXP-5 | Does restoring a session rotate the token / bump `refresh_token_write_count`? | Must re-capture after each switch or sessions die |
| EXP-6 | What is the minimum process kill set for a clean swap? | Switch speed |

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
