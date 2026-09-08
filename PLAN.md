# LeagueSwitcher — Master Plan

> **Internal design document.** Written while building this, kept because the reasoning is the
> useful part. If you just want to use the app, the [README](README.md) is the front door.

A personal Windows desktop app to switch between ~10 League of Legends accounts in one click, with
a dashboard of username, region, rank, level, and quick links (op.gg etc.).

Read [`docs/RESEARCH.md`](docs/RESEARCH.md) first — it contains the live-verified API surface and
file formats this plan is built on. Read [`docs/OVERNIGHT-PROTOCOL.md`](docs/OVERNIGHT-PROTOCOL.md)
before starting autonomous work. Track state in [`PROGRESS.md`](PROGRESS.md).

---

## 1. Feasibility verdict

**Yes, fully feasible — but not the way it was originally framed.**

The instinctive design is "store the password, replay it on demand." That path is blocked: Riot's
login flow now issues an **hCaptcha challenge on every login**, confirmed in this machine's own
client telemetry logs. No headless password replay survives that without a paid captcha solver,
which would be fragile and permanently at risk of breaking.

The design that does work is better anyway. The Riot Client persists a **long-lived, non-device-bound
OAuth refresh token** in `RiotGamesPrivateSettings.yaml`, valid for roughly **453 days** between
restores. So:

- **Enroll once per account** (log in with the password while you are present for the captcha).
- The app **captures that session file** into an encrypted vault.
- **Every switch after that** is a file swap plus a client relaunch. No password, no captcha, no
  network auth. Roughly 10–15 seconds, and potentially ~2 seconds if hot-swap (EXP-2) works.

You still enter username and password when creating a profile — they are stored encrypted and used
for enrollment and for automatic re-enrollment if a session ever dies. The end-user experience is
the one you asked for; the mechanism underneath is just sturdier than raw password replay.

**Risk to be explicit about:** automating the Riot Client is not something Riot formally sanctions.
Account switchers are widespread and long-lived, and none of this grants a gameplay advantage or
touches game memory, so practical risk is low — but it is not zero, and Riot can break the
mechanism in any patch. The architecture below is deliberately layered so a broken mechanism
degrades to a working one rather than to a dead app.

---

## 2. Architecture

### 2.1 Stack

| Layer | Choice | Reason |
|---|---|---|
| Shell | **Electron 3x** | Needs raw filesystem, process control, and self-signed HTTPS — all trivial in Node, none possible in a browser |
| UI | **React 19 + TypeScript + Vite** (`electron-vite`) | Fast iteration; the overnight agent can test renderer logic headlessly |
| Styling | **Tailwind CSS** + Radix primitives | Rapid, consistent dark UI |
| State | **Zustand** | Minimal boilerplate |
| Encryption | **Electron `safeStorage`** (Windows DPAPI) | No dependency, keys bound to the Windows user account, nothing to manage |
| Testing | **Vitest** + standalone Node probe scripts | Main-process logic must be testable without launching the GUI |
| Packaging | **electron-builder** → portable `.exe` | Single-file, no installer needed |

Alternative considered: C# WPF/WinUI (.NET 8 is installed) would produce a smaller, more native
binary. Rejected for this project because overnight autonomous iteration is materially faster in the
Node ecosystem and the UI work is heavier in XAML. If binary size ever matters, the core logic is
isolated in `main/riot/` and is a mechanical port.

### 2.2 Process model

```
┌──────────────── Electron Main (Node) ─────────────────┐
│  riot/lockfile.ts     read + watch both lockfiles     │
│  riot/rcApi.ts        Riot Client local API client    │
│  riot/lcuApi.ts       League Client (LCU) API client  │
│  riot/session.ts      capture / restore the yaml      │
│  riot/process.ts      detect, kill, launch            │
│  riot/region.ts       read + write region config      │
│  switch/strategies.ts S1..S4 ladder + orchestration   │
│  store/vault.ts       DPAPI-encrypted secret storage  │
│  store/accounts.ts    profile metadata + stats cache  │
│  enrich/collector.ts  post-login LCU data harvest     │
└───────────────────────┬───────────────────────────────┘
                        │ typed IPC (contextBridge, no nodeIntegration)
┌───────────────────────┴───────────────────────────────┐
│  Renderer (React) — account grid, detail, add/edit,   │
│  switch progress, settings                            │
└───────────────────────────────────────────────────────┘
```

The renderer **never** sees a password or a refresh token. IPC exposes only account metadata and
action commands.

### 2.3 Storage — nothing sensitive ever lives in the repo

All runtime data goes to `%APPDATA%\LeagueSwitcher\`, outside the git working tree entirely:

```
%APPDATA%\LeagueSwitcher\
  accounts.json          profile metadata + cached stats (no secrets)
  secrets.enc            DPAPI-encrypted { accountId: { username, password } }
  sessions\<id>.enc      DPAPI-encrypted copy of that account's RiotGamesPrivateSettings.yaml
  backups\               timestamped snapshots of the live yaml (safety net)
  logs\app.log           redacted; a scrubber strips token-shaped strings before write
```

This is stronger than gitignoring secrets: **there is nothing sensitive in the repo to leak.**
Defence in depth on top of that:

- `.gitignore` covers `*.enc`, `*.yaml` under any `data/`, `.env`, `secrets*`, `sessions/`
- A `pre-commit` hook runs a regex scan for JWT-shaped strings and `refresh_token`
- CI-style `npm run scan-secrets` script usable manually
- The logger has a mandatory redaction pass — unit-tested, so a token can never reach a log file

---

## 3. The switch strategy ladder

Four mechanisms, tried in order. Each degrades cleanly into the next.

### S1 — Cold session swap (primary, expected to be the workhorse)

```
1. Detect whether LeagueClient.exe is running.
   → If it is, SHOW A CONFIRMATION DIALOG naming the account that is about to be
     signed out, and do not proceed until the user confirms.
   → If a game is actually in progress (League of Legends.exe), REFUSE the switch outright.
2. Capture the currently-live session back into its account's vault entry (keeps it fresh)
3. Terminate LeagueClient*, RiotClient*, Riot Client.exe, RiotClientServices.exe; wait for exit
4. Decrypt target account's session yaml → write to
   %LOCALAPPDATA%\Riot Games\Riot Client\Data\RiotGamesPrivateSettings.yaml
5. Apply region if needed (EXP-4 decides whether this step is required)
6. Spawn RiotClientServices.exe  — RIOT CLIENT ONLY, no --launch-product flag.
   The League client is NOT started. The user launches it themselves.
7. Poll the Riot Client lockfile, then GET /rso-auth/v1/session until type == "authenticated"
8. Re-capture the session (it may have rotated — see EXP-5)
9. Capture puuid + Riot ID if this account does not have them yet (needed for §4)
```

**Confirmed decisions:** terminating a running League client is expected behaviour, but it must
**warn first**. The switch ends at the Riot Client — League is never auto-launched.
EXP-7 must determine the correct argument set for launching `RiotClientServices.exe` to the
account picker / home screen without starting a product.

### S2 — Hot refresh-token injection (fast path, pending EXP-2)

If `PUT /rso-auth/v1/authorization/refresh-token` accepts an injected token on a running client,
switching skips the kill/relaunch entirely: seconds instead of tens of seconds. Gate this behind a
setting defaulting to off until EXP-2 confirms it, and always fall back to S1 on any non-`authorized`
response.

### S3 — Password login via local API (enrollment, and session recovery)

```
POST /rso-authenticator/v1/authentication/riot-identity/start   { language, productId, state }
POST /rso-authenticator/v1/authentication/riot-identity/complete { username, password, remember: true }
  → type == "success"     → PUT /rso-auth/v1/session/login-token { authentication_type: "RiotAuth",
                                                                   login_token, persist_login: true }
  → type == "multifactor" → prompt for the code in-app
                          → POST /rso-authenticator/v1/authentication/multifactor
                            { multifactor: { otp, method, rememberDevice: true } }
  → type == "captcha" / captcha.type == "hcaptcha" → escalate to S4
  → type == "error"       → surface the error verbatim, do not retry blindly (respect retryAfter)
```

**S3b:** also try the legacy `PUT /rso-auth/v1/session/credentials` first — its schema has no captcha
field, so it may bypass the challenge entirely (EXP-3). If it works, it becomes the preferred
enrollment path.

### S4 — Assisted enrollment (guaranteed fallback)

The one path that cannot break. The app launches a clean Riot Client, uses
`POST /rso-auth/v1/auth-hints/hint` to prefill the username, and shows a small overlay:
"Finish signing in — I'll capture the session automatically." The user types the password and
clears the captcha. The app polls `/rso-auth/v1/session`, and the instant it reads `authenticated`
it harvests the yaml into the vault.

One-time, per account, and after that S1 handles every switch forever.

**Enrollment therefore always succeeds**, regardless of what Riot does to the password endpoints.

---

## 4. Data enrichment — fetched at app launch, for every account

**Requirement (confirmed):** account data must be refreshed from Riot's API **on app launch, for all
accounts at once**, so every card shows fresh real data without switching to it. This makes the
public Riot API the primary source and demotes the LCU to a bootstrap/fallback role.

### 4.1 API key — the one hard prerequisite

| Key type | Expiry | Rate limit | Verdict |
|---|---|---|---|
| Development | **24 hours** | 20/s, 100/2min | Unusable — would need re-pasting daily |
| **Personal** | **None** | 20/s, 100/2min | **Correct choice.** One-time application |
| Production | None | 500/10s | Overkill; requires review |

Ten accounts × ~3 calls = ~30 requests per launch. Personal-key limits are ~3× headroom on the
per-2-minute budget with no tuning needed. Key is entered once in Settings and stored DPAPI-encrypted
in the vault, never in the repo.

### 4.2 Bootstrap: Riot ID is the durable key, NOT puuid

> **⚠️ PUUIDs are encrypted per API key.** Verified 2026-08-31: the same account queried through
> `account-v1/by-riot-id` returns a *completely different* puuid depending on which key made the
> call —
> `<puuid-key-A>` (personal key) vs
> `<puuid-key-B>` (dev key).
>
> **Consequence:** the puuid from the local Riot Client — `success.puuid` in the login response, or
> the LCU's `current-summoner` — is **not** usable against the public API. Any design that captures
> a puuid locally and feeds it to the public API is broken. This was the original plan; it is wrong.

**The durable identifier is the Riot ID** (`gameName` + `tagLine`), which is key-independent.

Enrolment captures the Riot ID:

- **Primary** — LCU `/lol-summoner/v1/current-summoner` → `gameName`, `tagLine`, while that account
  is signed in (verified: `SUMMONER ONE` / `IDF`)
- **Fallback** — the user types it into the account form

Then at app launch, per account:

```
if (!puuid || puuidKeyFingerprint !== hash(currentApiKey)) {
    puuid = GET account-v1/accounts/by-riot-id/{gameName}/{tagLine}   // regional routing
    store puuid + puuidKeyFingerprint
}
... proceed with summoner-v4 / league-v4 / match-v5 using that puuid
```

Cache the puuid alongside a **fingerprint of the key that produced it**. If the key changes, every
cached puuid is invalid and must be re-resolved. Cost is one extra call per account, once — trivial
against the 100-per-2-minute budget.

Store `gameName`/`tagLine` as the source of truth. Re-resolve them each launch via
`account-v1/by-puuid` so renames are caught; if that 404s, fall back to the stored Riot ID.

The local `success.puuid` is still worth storing — it identifies the account *locally* and is useful
for matching a session file to a profile. Just never send it to the public API.

### 4.3 Launch-time refresh (per account, in parallel with a rate limiter)

| Call | Returns |
|---|---|
| `/riot/account/v1/accounts/by-puuid/{puuid}` *(regional)* | current `gameName`, `tagLine` — catches renames |
| `/lol/summoner/v4/summoners/by-puuid/{puuid}` *(platform)* | `summonerLevel`, `profileIconId`, `revisionDate` |
| `/lol/league/v4/entries/by-puuid/{puuid}` *(platform)* | per-queue `tier`, `rank`, `leaguePoints`, `wins`, `losses`, `hotStreak`, `veteran`, `freshBlood` |
| `/lol/match/v5/matches/by-puuid/{puuid}/ids?count=10` *(regional)* | recent match IDs → match-v5 detail for the form strip |

**Note:** Riot removed all `summonerId` / `accountId`-keyed endpoints. Everything must be
puuid-keyed. Do not use `/entries/by-summoner/{id}` — it is gone.

Results write into `accounts.json` with `lastUpdated`, and the UI renders cached values instantly
on launch while the refresh runs in the background, then updates in place. A manual refresh button
and a per-account retry cover failures. **One account failing must never block the others.**

### 4.4 Routing tables (both are required — they are different)

```
platform  (summoner-v4, league-v4)       regional (account-v1, match-v5)
NA  → na1      EUW  → euw1               na1,br1,la1,la2,oc1  → americas
LAN → la1      EUNE → eun1               euw1,eun1,tr1,ru     → europe
LAS → la2      TR   → tr1                kr,jp1               → asia
BR  → br1      RU   → ru                 oc1,ph2,sg2,th2,tw2,vn2 → sea
OCE → oc1      KR   → kr
JP  → jp1      PH2/SG2/TH2/TW2/VN2
```
Base URL: `https://{route}.api.riotgames.com`. **OCE routes to `americas` for account-v1 but `sea`
for match-v5** — verify at build time, this one has moved before.

Test accounts span **NA and LAN**, so cross-region routing is exercised from day one.

### 4.5 LCU — still used, in a reduced role

The LCU remains valuable for data the public API does not expose. Harvested opportunistically
whenever an account happens to be signed in:

BE / RP balances · loot and chests · honour level · owned champion count · mastery score ·
active bans and restrictions · XP progress to next level

### 4.6 Visual assets

| Asset | Source |
|---|---|
| Profile icons | `https://ddragon.leagueoflegends.com/cdn/{ver}/img/profileicon/{id}.png` |
| Rank crests | Community Dragon `.../rcp-fe-lol-static-assets/global/default/images/ranked-mini-crests/{tier}.svg` |
| Champion icons | Community Dragon `.../rcp-be-lol-game-data/global/default/v1/champion-icons/{id}.png` |
| Version pin | `https://ddragon.leagueoflegends.com/api/versions.json` → `[0]` |

All remote assets are **downloaded once and cached to disk** in `%APPDATA%\LeagueSwitcher\cache\`,
so the grid renders instantly and works offline. Rank crests are additionally bundled in the app as
a fallback — there are only ten tiers and they almost never change.

### 4.7 External links — constructed, not scraped

- op.gg — `https://op.gg/lol/summoners/{region}/{gameName}-{tagLine}`
- u.gg — `https://u.gg/lol/profile/{platform}/{gameName}-{tagLine}/overview`
- deeplol, porofessor — same pattern

---

## 5. UI

Dark, dense, keyboard-first. Three screens.

**Account grid** — the main screen. **The design is locked.** Build it to match
[`docs/mockup.html`](docs/mockup.html) — that file is the reference implementation, not a sketch.
Lift its CSS directly rather than reinterpreting it.

### Locked card hierarchy (approved 2026-08-31)

The single most important rule: **the username is the hero, rank is an accent.** An earlier draft
made rank dominate the card and was rejected. Do not reintroduce that.

```
┌──────────────────────────────────┐  ← 2px top stripe in tier colour
│                              ●   │  ← session-health dot
│  ⬤  Thunder4719#NA1              │  ← Riot ID, 1.35rem, Rajdhani 700 — LARGEST ELEMENT
│ 156  accountOne            │  ← login username, 0.7rem mono, --ink-3
│  ────────────────────────────    │
│  ◈ DIAMOND IV  12 LP        NA   │  ← rank line: 20px crest, 0.92rem tier, region right
│  89W 74L · 55% WR                │
│  ▰▰▰▰▰▱▱▱▱▱                      │  ← win-rate bar in tier colour
└──────────────────────────────────┘
```

| Element | Spec |
|---|---|
| Riot ID | 1.35rem, Rajdhani 700; `#TAG` at 0.82em in `--ink-3` |
| Avatar | 46px circle, real profile icon, 3.5px tier-coloured ring, level pip bottom-centre |
| Login username | 0.7rem JetBrains Mono, `--ink-3` |
| Rank line | 20px crest + tier name in tier colour + LP; region badge pushed right |
| Health dot | green valid · amber stale · red needs re-enrolment |
| Win-rate bar | 3px, filled in tier colour |
| Action bar | `Switch` (tier-filled, primary) + `Details` (ghost). Card body click = Details |

### Rank crest assets (locked)

Use Riot's own mini-crest SVGs from Community Dragon — **not hand-drawn substitutes**:

```
https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-mini-crests/{tier}.svg
```

Tiers: `iron bronze silver gold platinum emerald diamond master grandmaster challenger unranked`.
Each is 0.9–2.3 KB, single-path, with Riot's official colour baked in. Download once at first run,
cache to `%APPDATA%\LeagueSwitcher\cache\crests\`, and **bundle a copy in the app** as offline
fallback. Note the viewBoxes differ per tier (17×12 through 20×20) — render into a uniform
`0 0 20 20` viewport with `preserveAspectRatio="xMidYMid meet"`.

The larger `ranked-emblem/emblem-{tier}.png` (~80 KB) is available for the detail panel if wanted.

> **⚠️ Patch `diamond.svg` after download.** Community Dragon's mini-crest for Diamond ships tinted
> `#8141EB` — a purple nearly identical to Master's `#9D48E0`. Sampling the full-size
> `emblem-diamond.png` confirms the real Diamond emblem is **blue** (hue 225–240°, e.g. `#24366C`,
> `#36487E`). Rewrite that one fill to `#4C6FD9` on download. Every other tier's mini-crest was
> verified against its emblem and is correct — do not "fix" the others.

**Official Riot tier colours** (from the crest artwork) and the lightened variants used for UI text,
because several are too dark to read on `#151B26`:

| Tier | Riot hex (crest) | UI hex (text/accent) |
|---|---|---|
| iron | `#51484A` | `#8A7F81` |
| bronze | `#8C513A` | `#C08160` |
| silver | `#80989D` | `#A8BEC4` |
| gold | `#CD8837` | `#E8A945` |
| platinum | `#25ACD6` | `#45C3E8` |
| emerald | `#149C3A` | `#2ECC5B` |
| diamond | `#4C6FD9` ⚠️ | `#7E9DF0` |
| master | `#9D48E0` | `#BC72F0` |
| grandmaster | `#CD4545` | `#E56666` |
| challenger | `#F4C874` | `#F4C874` |
| unranked | `#63666B` | `#8A8E95` |

### Account detail panel (locked)

Opens on card click or the `Details` button. 430px slide-over from the right, tier-tinted header.
Sections in order:

1. **Header** — avatar, Riot ID, login username, compact rank line
2. **Account data** — 2-column stat grid: level, region, solo/duo rank, LP, W/L, win rate,
   session health, last played
3. **Look up** — op.gg, u.gg, DeepLoL (constructed from Riot ID + region)
4. **Credentials** — editable login username and password, with a show/hide toggle and Save.
   **This is how the user rotates a password after changing it on Riot's site.** Saving writes
   through to the encrypted vault only; it does not re-authenticate.
   Hint text must explain that the existing session keeps working, and that **Re-enrol** is the
   fix if Riot invalidated the session when the password changed.
5. **Actions** — `Switch to this account` (tier-filled primary), `Re-enrol session`, `Delete`

`Esc` closes the panel; if the switch confirmation is open, `Esc` closes that first.

**Tier colour drives** the top stripe, card border, hover glow, avatar ring, corner radial wash and
win-rate bar — nothing else on screen is saturated, so the grid still reads by rank at a glance
without rank consuming space.

Tier palette (locked): iron `#8A7F76` · bronze `#A9714B` · silver `#9FB0BD` · gold `#E0A93A` ·
platinum `#3FB9AE` · emerald `#25B36B` · diamond `#7B96E8` · master `#C356E0` ·
grandmaster `#E85055` · challenger `#F1D08A` · unranked `#4A5666`

Typography (locked): **Rajdhani** 500/600/700 for UI, names and numbers · **Barlow** 400/500/600 for
body · **JetBrains Mono** for usernames and technical values. Dark theme only.

Behaviour: active account pinned and distinct at the top. Cards lift 2px on hover and reveal a
tier-coloured "Switch" bar. Search filters as you type; `Ctrl+1..9` switches directly. Skeleton
shimmer while the launch refresh lands, then values fade in place. Unranked accounts show
`n/5 placements` instead of LP. Respect `prefers-reduced-motion` on every transition.

**Account detail** — specified above as the locked slide-over panel. Later additions (recent match
strip, notes field, per-account auto-launch preference) slot in as extra `psect` blocks.

**Add / edit account** — username, password, optional label and colour tag. Runs the enrollment
ladder with live status, including the 2FA prompt and the assisted-login overlay.

**Switch progress** — a modal with real step feedback ("closing client", "restoring session",
"waiting for login", "fetching rank") rather than an opaque spinner, because a 15-second operation
with no feedback feels broken.

**Settings** — vault location, launch-LoL-after-switch default, hot-swap toggle, optional Riot API
key, export/import vault, and a panic "restore original session" button.

---

## 6. Execution phases

Each phase ends at a **verification gate**. Do not advance past a failing gate — record the failure
in `PROGRESS.md` and take the documented fallback.

### Phase 0 — Safety net and experiments (do this first, always)

- [ ] **P0.1** Back up the current `RiotGamesPrivateSettings.yaml`, `RiotClientSettings.yaml`, and both
      lockfile paths to `%APPDATA%\LeagueSwitcher\backups\baseline-<timestamp>\`. Write a
      `restore-baseline.ps1` next to it that restores them. **Nothing else runs until this exists.**
- [ ] **P0.2** Standalone Node probe scripts in `scripts/probes/` for each experiment
- [ ] **P0.3** Run EXP-1 (cold swap round-trip using the *same* account: capture → kill → wipe →
      restore → relaunch → confirm auto-login). This proves the mechanism with zero risk of
      cross-account contamination.
- [ ] **P0.4** Run EXP-5 (does the token rotate on restore?) — compare `refresh_token_write_count`
      and `last_token_creation_time` before and after
- [ ] **P0.5** Run EXP-6 (minimum kill set) and EXP-2 (hot-swap injection)
- [ ] **P0.6** Run EXP-3 (legacy credentials endpoint) — **only with a credential the user has
      explicitly supplied for testing.** If none is available, mark BLOCKED and move on; do not
      attempt to guess or reuse anything.
- [ ] **P0.7** Record every outcome in `docs/RESEARCH.md` §7 with the actual observed response

**Gate:** EXP-1 passes. If EXP-1 fails, stop and escalate — the entire design rests on it.

### Phase 1 — Core engine (headless, no UI)

- [ ] **P1.1** `riot/lockfile.ts` — parse both lockfiles, watch for changes, handle stale files
      (validate the PID is alive; the observed lockfile was 2 days old)
- [ ] **P1.2** `riot/rcApi.ts` and `riot/lcuApi.ts` — typed clients, self-signed TLS, Basic auth,
      retry with backoff, structured errors
- [ ] **P1.3** `riot/process.ts` — enumerate, terminate with graceful-then-forced escalation, launch,
      wait-for-ready
- [ ] **P1.4** `riot/session.ts` — capture, restore, validate, diff, and a token-shape sanity check
- [ ] **P1.5** `store/vault.ts` — DPAPI encrypt/decrypt, atomic writes, corruption recovery
- [ ] **P1.6** `switch/strategies.ts` — the S1..S4 ladder with an event emitter for progress
- [ ] **P1.7** A `scripts/cli.ts` harness: `list`, `capture`, `switch <id>`, `status` — full
      functionality before any pixel is drawn

**Gate:** `npm run cli -- switch <id>` performs a real switch between two enrolled accounts.

### Phase 2 — Data layer

- [ ] **P2.1** `api/riotApi.ts` — public Riot API client with a token-bucket rate limiter
      (20/s, 100/2min), retry on 429 honouring `Retry-After`, and both routing tables (§4.4)
- [ ] **P2.2** `api/refreshAll.ts` — launch-time parallel refresh across all accounts;
      **one account failing must not block the others**; per-account error state surfaced in the UI
- [ ] **P2.3** puuid bootstrap: from `success.puuid` at enrolment, from LCU, or from a
      manually-entered Riot ID via `account-v1`
- [ ] **P2.4** `accounts.json` cache with `lastUpdated` and a schema version; render cached first,
      update in place when the refresh lands
- [ ] **P2.5** `assets/cache.ts` — Data Dragon version pin, profile icons and rank crests
      downloaded once to `%APPDATA%\LeagueSwitcher\cache\`, bundled crest fallback
- [ ] **P2.6** `enrich/collector.ts` — LCU harvest for what the public API lacks (BE/RP, loot,
      honour, bans); every endpoint optional, a missing one degrades a field not the harvest
- [ ] **P2.7** External-link builders using the platform mapping

**Gate:** launching the app populates all four test accounts (NA and LAN) with live rank, level and
icon, without switching to any of them.

### Phase 3 — UI

- [ ] **P3.1** Electron + Vite + React + Tailwind scaffold, typed IPC via `contextBridge`
- [ ] **P3.2** Account grid — **port `docs/mockup.html` directly.** The design is locked and
      approved; lift its CSS and DOM structure rather than redesigning. See §5 for the spec
- [ ] **P3.3** Switch flow with live step progress and error surfacing
- [ ] **P3.4** Add/edit account with the full enrollment ladder, 2FA prompt, and assisted-login overlay
- [ ] **P3.5** Account detail view
- [ ] **P3.6** Settings, including the panic restore button
- [ ] **P3.7** Keyboard shortcuts, tray icon, single-instance lock

**Gate:** the whole loop is usable end-to-end with the mouse only.

### Phase 4 — Hardening

- [ ] **P4.1** Log redaction with unit tests proving tokens never reach disk
- [ ] **P4.2** Secret-scan pre-commit hook and `npm run scan-secrets`
- [ ] **P4.3** Graceful handling: client already running, game in progress (**refuse to switch
      mid-game** and say why), Vanguard active, network down, session expired
- [ ] **P4.4** Session-health checker with proactive "re-enroll needed" flags
- [ ] **P4.5** Vault export/import, encrypted with a user passphrase for portability
- [ ] **P4.6** Vitest coverage on vault, session, redaction, and the strategy ladder

### Phase 5 — Packaging

- [ ] **P5.1** `electron-builder` portable exe, app icon, version stamping
- [ ] **P5.2** `README.md` with setup, the honest ToS note, and a mechanism explainer
- [ ] **P5.3** First-run wizard: baseline backup, then enroll the current account in one click

### Phase 6 — Optional extras

- [ ] Riot API key support for offline rank refresh across all accounts
- [ ] Auto-launch LoL after switch, per account
- [ ] Champion mastery highlights, match-history strip
- [ ] Multi-product support (TFT, Valorant — the same session file covers all Riot products)
- [ ] Account groups / tags (smurf, main, duo, region)

---

## 7. Hard rules for the overnight run

1. **Phase 0.1 backup before anything else.** No exceptions.
2. **Never commit secrets.** Runtime data lives in `%APPDATA%`, never the repo.
3. **Never log a token, password, or lockfile password.** Redaction is enforced in code, not by care.
4. **Do not attempt hCaptcha solving.** Out of scope by decision, not by oversight.
5. **Do not test destructive paths against the only known-good session** without a verified backup
   and a verified restore script.
6. **Do not invent endpoints.** Re-pull `/swagger/v3/openapi.json` and check. The spec is live.
7. **If a gate fails, stop and record it** in `PROGRESS.md`. Do not build on an unverified mechanism.
8. **Test credentials exist and may be used** — 4 accounts at
   `%APPDATA%\LeagueSwitcher\test-credentials.json`. They must never be copied into the repo, echoed
   into a log, or written to a terminal transcript. Migrate them into the encrypted vault at P1.5 and
   delete the plaintext file.
9. **Cap login attempts at 2 per account, ever.** Riot rate-limits and locks accounts on repeated
   failures. If a login fails twice, mark the account `BLOCKED` in `PROGRESS.md` and stop — do not
   retry, do not try username variants. This applies especially to account 3, whose username is
   ambiguous: **do not guess between `accountTwo` and `accountTwo`.** Wait for confirmation.
10. **Respect `retryAfter`** in any auth error response. Never loop on a failing auth call.

---

## 8. Decisions — confirmed 2026-08-31

| Question | Answer |
|---|---|
| Stack | **Electron + React** |
| Regions | **Multi-region** — test accounts span NA and LAN |
| Running League client on switch | **Terminate it, but warn first.** Refuse outright if a game is in progress |
| What gets launched after a switch | **Riot Client only.** League is never auto-launched |
| Account data source | **Riot public API at app launch, all accounts** — not on-switch (§4) |
| Visual treatment | Real profile icons, rank crests, tier colouring (§5) |
| Test credentials | **Provided** — 4 accounts, stored at `%APPDATA%\LeagueSwitcher\test-credentials.json`, never in the repo |
| Repository | **Private** |

| Riot API key | **Dev key for tonight, personal key applied for.** See [`docs/API-KEY-SETUP.md`](docs/API-KEY-SETUP.md). Read from `%APPDATA%\LeagueSwitcher\riot-api-key.txt` |
| 2FA | **None on the four test accounts.** The 2FA path is still built and unit-tested for the remaining ~6 |
| Account 3 username | **Confirmed `accountTwo`** (capital i) |

### Consequence for the overnight run

The dev key expires 24h after generation, so Phase 2 must **not** hard-fail when the key is missing
or expired. Required behaviour:

- Missing key → UI shows a clear "add your API key in Settings" state, app remains usable
- `401` → surface "key expired or invalid", link to the setup guide, keep cached data on screen
- `429` → honour `Retry-After`, back off, never spin
- Cached `accounts.json` data always renders regardless of key state

If the key has expired by the time the overnight run reaches P2, that is **expected**, not a
failure. Fall back to the mock, finish the code, and note it for morning verification.
