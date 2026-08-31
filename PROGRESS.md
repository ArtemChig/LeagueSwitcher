# Progress Ledger

Single source of truth for what is actually done. Update **as work completes**, not in batches.
See [`docs/OVERNIGHT-PROTOCOL.md`](docs/OVERNIGHT-PROTOCOL.md) for the rules.

Status values: `TODO` · `DOING` · `DONE` · `BLOCKED` · `FAILED`
Only one task may be `DOING` at a time.

---

## Current state

**Phase:** 0 — in progress (P0.1 done)
**Last updated:** 2026-08-31 — plan reviewed and approved, UI design locked
**Baseline backup exists:** ✅ YES — `%APPDATA%\LeagueSwitcher\backups\baseline-20260831-054810`
**Git:** initialised, history verified free of secrets. Commit locally, **never push**.

**Already verified before the run started:**
- Riot Client local API surface (789 endpoints) — `docs/RESEARCH.md`
- **Permanent personal API key** validated end-to-end via `scripts/probes/riot-api-check.mjs`:
  `account-v1 → summoner-v4 → league-v4 → match-v5` all 200, matching LCU values
  (BRONZE I, 5 LP, 13W/10L). Data Dragon pinned at `16.17.1`
- **PUUIDs are key-scoped** — the local client's puuid is NOT usable against the public
  API. Riot ID is the durable identifier. See PLAN §4.2 and RESEARCH §9
- UI design approved and locked — `docs/mockup.html` is the reference implementation
- Rank crests: real Riot assets; `diamond.svg` ships mis-tinted purple, patch to `#4C6FD9`

---

## Phase 0 — Safety net and experiments

| ID | Task | Status | Verified | Notes |
|---|---|---|---|---|
| P0.1 | Baseline backup + `restore-baseline.ps1` | **DONE** | 2026-08-31 05:48 | `baseline-20260831-054810` (SUMMONER ONE#TAG1). Restore script syntax-checked |
| P0.2 | Probe scripts in `scripts/probes/` | TODO | | |
| P0.3 | EXP-1 cold swap round-trip (same account) | TODO | | **Phase gate** |
| P0.4 | EXP-5 token rotation on restore | TODO | | |
| P0.5 | EXP-6 min kill set, EXP-2 hot-swap injection | TODO | | |
| P0.6 | EXP-3 legacy credentials endpoint | TODO | | Test creds available. **Max 2 attempts per account** |
| P0.7 | EXP-7 launch Riot Client with no product | TODO | | Switch must not start League |
| P0.8 | Record outcomes in `docs/RESEARCH.md` §7 | TODO | | |

## Phase 1 — Core engine

| ID | Task | Status | Verified | Notes |
|---|---|---|---|---|
| P1.1 | `riot/lockfile.ts` | TODO | | Must handle stale lockfiles (validate PID) |
| P1.2 | `riot/rcApi.ts`, `riot/lcuApi.ts` | TODO | | |
| P1.3 | `riot/process.ts` | TODO | | |
| P1.4 | `riot/session.ts` | TODO | | |
| P1.5 | `store/vault.ts` | TODO | | |
| P1.6 | `switch/strategies.ts` | TODO | | |
| P1.7 | `scripts/cli.ts` harness | TODO | | **Phase gate:** real switch via CLI |

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

- Multi-account switching — needs a second account enrolled by the user
- Riot IDs for the 4 test accounts — unknown until each is signed into once (login username is
  not a Riot ID and cannot be looked up)

## Blocked / failed

*(populate during the run, with actual error text)*

## Deviations from PLAN.md

*(populate during the run)*
