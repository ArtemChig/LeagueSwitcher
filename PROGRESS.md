# Progress Ledger

Single source of truth for what is actually done. Update **as work completes**, not in batches.
See [`docs/OVERNIGHT-PROTOCOL.md`](docs/OVERNIGHT-PROTOCOL.md) for the rules.

Status values: `TODO` · `DOING` · `DONE` · `BLOCKED` · `FAILED`
Only one task may be `DOING` at a time.

---

## Current state

**Phase:** 1 — **COMPLETE** (P1.1-P1.7). Phase 0 complete bar P0.6 (BLOCKED, no credentials)
**Next:** Phase 2 — data layer
**Last updated:** 2026-08-31 10:55 — a real switch runs through the engine: `Switched via S1 in 12.8s`
**Baseline backup exists:** ✅ YES — `%APPDATA%\LeagueSwitcher\backups\baseline-20260831-060859`
  (re-taken this run; the previously recorded one was gone — see "Blocked / failed")
**Git:** initialised, history verified free of secrets. Commit locally, **never push**.

**Already verified before the run started:**
- Riot Client local API surface (789 endpoints) — `docs/RESEARCH.md`
- ~~**Permanent personal API key** validated end-to-end~~ — ⚠️ **the key file is GONE.**
  `riot-api-key.txt` no longer exists on this machine, so this claim cannot be re-verified and
  no public-API call can be made tonight. The recorded findings (`account-v1 → summoner-v4 →
  league-v4 → match-v5` all 200; BRONZE I, 5 LP, 13W/10L; Data Dragon `16.17.1`) are kept as
  history, not as live state
- **PUUIDs are key-scoped** — the local client's puuid is NOT usable against the public
  API. Riot ID is the durable identifier. See PLAN §4.2 and RESEARCH §9
- UI design approved and locked — `docs/mockup.html` is the reference implementation
- Rank crests: real Riot assets; `diamond.svg` ships mis-tinted purple, patch to `#4C6FD9`

---

## Phase 0 — Safety net and experiments

| ID | Task | Status | Verified | Notes |
|---|---|---|---|---|
| P0.1 | Baseline backup + `restore-baseline.ps1` | **DONE** | 2026-08-31 06:09 | Re-taken: `baseline-20260831-060859`. 4 files (rc session 3704B w/ live refresh_token, rc settings 3882B, lol session 32B, lol settings 362B) + `manifest.json` with SHA256. `restore-baseline.ps1` regenerated and parse-checked. Repeatable via `scripts/backup-baseline.ps1` |
| P0.2 | Probe scripts in `scripts/probes/` | **DONE** | 2026-08-31 10:20 | `lib/riotlocal.mjs` (lockfiles, local HTTPS, process control, session capture/restore, redaction) + `client-status.mjs`, `swagger-dump.mjs`, `exp1-cold-swap.mjs`. All run clean |
| P0.3 | EXP-1 cold swap round-trip (same account) | **DONE — PASS** | 2026-08-31 10:20 | **PHASE GATE CLEARED.** Negative control confirmed (wiped session -> `PendingLoginStrategy`, not authenticated); restore -> `200/authenticated` in **~2.1s**. Signed in as SUMMONER ONE#TAG1 |
| P0.4 | EXP-5 token rotation on restore | **DONE — answered** | 2026-08-31 10:20 | Fell out of the EXP-1 run. `refresh_token_write_count` 34->35, `id_token` **rotates**, `refresh_token` unchanged, `last_token_creation_time` updated. **Re-capture after every switch is required.** Client does NOT rewrite the session on exit |
| P0.5 | EXP-6 min kill set, EXP-2 hot-swap injection | **DONE — EXP-2 FAIL** | 2026-08-31 10:26 | **EXP-2 FAIL:** `PUT /rso-auth/v1/authorization/refresh-token` -> `404 RPC_ERROR "Not Found"` in **both** states (signed-out and authenticated), and `GET` on the same path 404s too. The route is in the 789-path spec but is **not implemented at runtime on this build**. S2 hot-swap is off the table; **S1 cold swap is the switch path**. **EXP-6 PASS:** stopping **`RiotClientServices` alone** brought down all 6 `Riot Client` Electron helpers and `RiotClientCrashHandler` within 4s — minimum kill set is one process. ⚠️ measured with League NOT running; `LeagueClient*` is a separate tree and must still be swept |
| P0.6 | EXP-3 legacy credentials endpoint | **BLOCKED (partly answered)** | 2026-08-31 10:28 | Full test BLOCKED: `%APPDATA%\LeagueSwitcher\test-credentials.json` does not exist and hard rule 8 forbids guessing. **Reachability WAS settled at zero cost:** one request with empty strings (no account named, so no attempt budget spent) returned `400 RPC_ERROR "No previous RSO session found"` — **not** the `404 "Not Found"` that EXP-2 got, so the route **is implemented at runtime**. S3b stays a live candidate; whether it bypasses hCaptcha needs one real credential. Probe is structurally incapable of accepting credentials |
| P0.7 | EXP-7 launch Riot Client with no product | **DONE — PASS** | 2026-08-31 10:26 | `RiotClientServices.exe` with **no arguments** brings the client up and signs in. Verified across 5 launches: **no `LeagueClient*` process and no LCU lockfile ever appeared.** League is not started, exactly as PLAN §8 requires |
| P0.8 | Record outcomes in `docs/RESEARCH.md` §7 | **DONE** | 2026-08-31 10:32 | §7 rewritten from open questions into outcomes: all 7 experiments, actual responses, plus two findings that change the design (spec != runtime; the client self-identifies the account with no API key) |

## Phase 1 — Core engine

| ID | Task | Status | Verified | Notes |
|---|---|---|---|---|
| P1.1 | `riot/lockfile.ts` | **DONE** | 2026-08-31 10:52 | Parses both lockfiles, classifies absent/malformed/stale/live. Stale detection validates the PID with signal 0 (EPERM counts as alive). Password split is bounded so a colon in the password cannot corrupt the parse. Directory watcher, because a watch on a file that does not exist never fires |
| P1.2 | `riot/rcApi.ts`, `riot/lcuApi.ts` | **DONE** | 2026-08-31 10:52 | `localApi.ts` holds the shared transport: self-signed TLS scoped per-request (never `NODE_TLS_REJECT_UNAUTHORIZED`, which would also disable verification for the API-key calls), Basic auth, retry on transport errors only. `LocalApiError` distinguishes `isNotInitialised` from `isRouteMissing` — the distinction EXP-1/EXP-2 turned on. `readLoginState()` merges both session endpoints. Every LCU call is optional by construction |
| P1.3 | `riot/process.ts` | **DONE** | 2026-08-31 10:52 | Line-oriented enumeration (PS 5.1's `{"value":[...]}` JSON quirk documented in-file). Graceful `CloseMainWindow` then forced. `shutdownRiot` uses EXP-6's finding: narrow kill of `RiotClientServices` first, broad sweep only if something survives. Refuses outright while a game runs |
| P1.4 | `riot/session.ts` | **DONE** | 2026-08-31 10:52 | Capture/restore/validate/diff. Restores are **atomic** (temp + rename) so a crash cannot truncate a live session. `validateSessionFile` refuses to store or restore anything implausible, and flags `is_dpop_bound: true` — the assumption the design rests on. Captures are byte-for-byte copies; the file is never re-serialised |
| P1.5 | `store/vault.ts` | **DONE** | 2026-08-31 10:52 | DPAPI via .NET `ProtectedData` (CurrentUser + app entropy) rather than Electron `safeStorage`, so the headless CLI and the GUI share one format. **Plaintext passes over stdin, never argv** — command lines are world-readable. Verified round-trip including quotes/newlines. Credentials in one blob (DPAPI is ~200ms/call), sessions one file each. A vault that will not decrypt is renamed aside, never deleted. Migrates + deletes legacy plaintext files |
| P1.6 | `switch/strategies.ts` | **DONE** | 2026-08-31 10:55 | S1 (proven), S2 (behind a flag, dead per EXP-2, falls through), S3 hooks, S4 assisted enrolment. Ordering is the safety property: refuse if a game runs -> confirm before closing League -> **verify the target session decrypts before touching anything** -> capture the current session -> only then stop/restore/relaunch. S4 signs out by writing a signed-out file rather than calling logout, which could revoke the token server-side |
| P1.7 | `scripts/cli.ts` harness | **DONE** | 2026-08-31 10:55 | `status`/`list`/`capture`/`switch`/`enrol`/`health`/`vault`/`api-key`/`forget`. All output goes through the redactor. **GATE: a real switch ran — `switch accountone --yes` -> `Switched via S1 in 12.8s`, sign-in ~2.2s, session re-captured.** Only partially satisfies the written gate: it switched to the one enrolled account (a real capture -> kill -> restore -> relaunch -> verify cycle), not *between two*, because only one account exists. See morning verification |

## Phase 2 — Data layer

| ID | Task | Status | Verified | Notes |
|---|---|---|---|---|
| P2.1 | `api/riotApi.ts` + rate limiter + routing tables | TODO | | Port `scripts/probes/riot-api-check.mjs` — routing tables already verified there |
| P2.2 | `api/refreshAll.ts` launch-time parallel refresh | TODO | | One failure must not block others |
| P2.3 | **Riot ID → puuid** resolution + key-fingerprint cache | TODO | | ⚠️ puuid is key-scoped; local puuid is NOT usable. See PLAN §4.2 |
| P2.4 | `accounts.json` cache + schema version | TODO | | Render cached first |
| P2.5 | Asset cache — icons, rank crests, ddragon pin | TODO | | Bundled crest fallback |
| P2.6 | `enrich/collector.ts` LCU harvest | TODO | | Every endpoint optional |
| P2.7 | External link builders | TODO | | **Phase gate:** all 4 test accounts populated on launch |

## Phase 3 — UI

| ID | Task | Status | Verified | Notes |
|---|---|---|---|---|
| P3.1 | Electron + Vite + React + Tailwind scaffold | TODO | | |
| P3.2 | Account grid | TODO | | **Design LOCKED** — port `docs/mockup.html`, do not redesign |
| P3.3 | Switch flow + progress | TODO | | |
| P3.4 | Add/edit + enrollment ladder | TODO | | |
| P3.5 | Account detail slide-over + credential editing | TODO | | **Design LOCKED** — see PLAN §5 |
| P3.8 | Rank crest asset cache (Community Dragon SVGs) | TODO | | Bundle offline fallback |
| P3.6 | Settings + panic restore | TODO | | |
| P3.7 | Shortcuts, tray, single-instance | TODO | | |

## Phase 4 — Hardening

| ID | Task | Status | Verified | Notes |
|---|---|---|---|---|
| P4.1 | Log redaction + tests | TODO | | |
| P4.2 | Secret-scan hook | **DONE** | 2026-08-31 | `scripts/scan-secrets.mjs` + `.git/hooks/pre-commit`. Verified: blocks planted key AND password |
| P4.3 | Edge cases (in-game, Vanguard, offline) | TODO | | |
| P4.4 | Session-health checker | TODO | | |
| P4.5 | Vault export/import | TODO | | |
| P4.6 | Vitest coverage | TODO | | |

## Phase 5 — Packaging

| ID | Task | Status | Verified | Notes |
|---|---|---|---|---|
| P5.1 | electron-builder portable exe | TODO | | |
| P5.2 | README | TODO | | |
| P5.3 | First-run wizard | TODO | | |

---

## Confirmed inputs (2026-08-31)

- **Test accounts (4):** `accountFour` (NA), `accountThree` (LAN), `accountTwo` (NA),
  `accountOne` (NA). Credentials at `%APPDATA%\LeagueSwitcher\test-credentials.json`.
- **No 2FA** on any of the four. The 2FA code path is still built and unit-tested.
- **Max 2 login attempts per account, ever.** Then `BLOCKED`. No username variants, no retry loops.
- **API key: PERMANENT personal key approved** (App ID <app-id>, no expiry), stored at
  `%APPDATA%\LeagueSwitcher\riot-api-key.txt`. Phase 2 can be built and tested against live data —
  no mock needed. Still handle a missing/invalid key gracefully in the UI.

## Needs morning verification

*(populate during the run — anything implemented against a mock or otherwise unexercised)*

1. **`%APPDATA%\LeagueSwitcher\` was missing at run start** — see "Blocked / failed".
   Restore or re-create `riot-api-key.txt` and `test-credentials.json`. Until then EXP-3's real
   test and all live public-API verification are impossible.

2. **EXP-4 (region) is not conclusive.** Only an NA account is enrolled. The evidence says region
   travels inside the session's own claims (`userInfo.region.id == "NA1"`, `lol_region`,
   `affinity.pp`), so the build assumes **no region file write is needed**. Confirm by switching
   to a LAN or EUW account and checking the region badge and `/riotclient/region-locale`.

3. **EXP-3's real test is one credential away.** The route is implemented (400, not 404). One
   attempt, hard rule 9 applies. If it works, headless enrolment becomes possible.

4. **Multi-account switching is implemented but not proven.** `npm run cli -- switch` was run for
   real and succeeded (S1, 12.8s), but against the single enrolled account — a genuine
   capture -> kill -> restore -> relaunch -> verify cycle, not a cross-account one. To close this:
   `npm run cli -- enrol <username>` for a second account, then `npm run cli -- switch <id>`.
   The cross-account paths that stay unproven until then: capturing account A's session before
   overwriting it with B's, and whether region follows across a region boundary (EXP-4).

5. **Riot IDs for the other 3 test accounts** are still unknown — but no longer need to be typed
   in. `userInfo.preferred_username` + `riotID` from the Riot Client name the account
   automatically the first time it signs in. Already resolved this way:
   `accountOne` -> `SUMMONER ONE#TAG1` (NA1).

6. **`refresh_token` did not rotate** across four cycles, but that is four cycles on one account
   over ~15 minutes. Watch whether a stored session still logs in after days, not minutes.

## Blocked / failed

### ⚠️ 2026-08-31 06:08 — `%APPDATA%\LeagueSwitcher\` did not exist at run start

The ledger claimed a baseline backup, a permanent API key and test credentials were on disk.
**None of them were.** `Test-Path "$env:APPDATA\LeagueSwitcher"` returned `False`; the parent
`%APPDATA%` listing contains no `LeagueSwitcher` entry at all. The whole directory is gone or was
never created on this machine. `%LOCALAPPDATA%\Riot Games\` and `C:\Riot Games\` are both intact.

Consequences, in order of severity:

| Missing | Blocks | Handling |
|---|---|---|
| `backups\baseline-*\` | everything (hard rule 1) | **RESOLVED** — re-taken as `baseline-20260831-060859` before any other work |
| `riot-api-key.txt` | live Phase-2 verification | Phase 2 still built; PLAN §8 already mandates graceful missing-key handling. Gate P2.7 cannot be verified live |
| `test-credentials.json` | P0.6 (EXP-3), enrolling accounts 2-4 | **P0.6 BLOCKED.** Hard rule 8 forbids guessing credentials |

Nothing was reconstructed from memory. No credential value appears anywhere in this repo.

## Deviations from PLAN.md

*(populate during the run)*
