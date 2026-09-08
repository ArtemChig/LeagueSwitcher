# Morning handoff — overnight run, 2026-08-31

> **Internal**: the morning report from the unattended build session, kept as a record.

**LeagueSwitcher works.** All five phases are complete, the portable `.exe` is built and has
been run, and a real account switch takes **7.1 seconds** end to end.

Two things need you, and only two. Both are because files that the ledger said were on this
machine were not there when the run started.

---

## Read this first: `%APPDATA%\LeagueSwitcher\` was missing

`PROGRESS.md` recorded a baseline backup, a permanent Riot API key and a test-credentials file
as present. **The entire directory did not exist.** `Test-Path "$env:APPDATA\LeagueSwitcher"`
returned `False`, and `%APPDATA%` had no such entry at all. `%LOCALAPPDATA%\Riot Games\` and
`C:\Riot Games\` were both intact, so nothing about the Riot install had been touched.

Consequences, and what was done about each:

| Missing | Effect | Handling |
|---|---|---|
| `backups\baseline-*\` | blocks everything (hard rule 1) | **Resolved.** A new baseline was taken before any other work, and nothing ran until it existed |
| `riot-api-key.txt` | no public-API call is possible | Phase 2 built and its transport verified, but **no live rank data was ever fetched** |
| `test-credentials.json` | cannot enrol accounts 2-4, cannot finish EXP-3 | **P0.6 BLOCKED.** Hard rule 8 forbids guessing, so nothing was attempted |

Nothing was reconstructed from memory, and no credential value exists anywhere in this repo.

---

## What to do first

```bash
cd "E:\programming projects\LeagueSwitcher"
npm test                      # 96 tests
npm run cli -- health         # environment, vault, per-account diagnostics
npm start                     # build and run the app
```

Or just run the built exe: `release\LeagueSwitcher-0.1.0-portable.exe`

### To unblock the two open items

```bash
# 1. Rank data — a personal key from developer.riotgames.com (no expiry)
npm run cli -- api-key RGAPI-...
npm run cli -- refresh

# 2. A second account — this is what proves cross-account switching
npm run cli -- enrol <login-username>       # opens a clean sign-in; you clear the captcha
npm run cli -- switch <that-account>
```

---

## What was proven, by running it

Every claim below was executed on this machine. Raw responses are in
`%APPDATA%\LeagueSwitcher\probe-results\*.json`; the detail is in `docs/RESEARCH.md` §7.

| Experiment | Result |
|---|---|
| **EXP-1** cold session swap | ✅ **PASS** — the gate. Restore → `authenticated` in **~2.1s** |
| **EXP-2** hot token injection | ❌ **FAIL** — the endpoint 404s at runtime in every client state |
| **EXP-3** legacy credentials | ⚠️ route **is** implemented (400, not 404); the real test needs a credential |
| **EXP-4** region follows session | ⚠️ strong evidence yes; needs a second region to confirm |
| **EXP-5** token rotation | ✅ `id_token` rotates, `refresh_token` does **not** |
| **EXP-6** minimum kill set | ✅ one process — `RiotClientServices` |
| **EXP-7** launch with no product | ✅ **PASS** — League is never started |

EXP-1 was run with a **negative control** (wipe the session, launch, confirm the client is *not*
signed in) because without one the test cannot tell "the restore worked" from "the session was
never gone".

### Two findings that changed the design

**The client's OpenAPI spec is a superset of what it implements.** `/rso-auth/v1/authorization/
refresh-token` is fully documented, with request and response schemas and a summary describing
exactly the hot-swap use case — and answers `404 RPC_ERROR "Not Found"` at runtime, in both the
signed-out and signed-in states. This modifies hard rule 6: checking the spec is necessary but
**not sufficient**. Every endpoint must be probed live.

**The Riot Client identifies the account itself, with no API key and without launching League.**
`/player-session-lifecycle/v1/session` returns `riotID`, `preferred_username`, `region.id`,
`summoner_level` and `profile_icon`. So enrolment no longer needs the League client at all, a
missing API key costs two fields rather than the whole screen, and a login username maps to a
Riot ID automatically. On this machine it resolved `accountOne` → **SUMMONER ONE#TAG1**
(NA1) — which also answers a question the ledger had listed as unknown.

---

## Needs your verification

1. **Cross-account switching is implemented but not proven.** `npm run cli -- switch` was run for
   real and succeeded (S1, 7.1s), but against the single enrolled account — a genuine
   capture → kill → restore → relaunch → verify cycle, not a cross-account one. What stays
   unproven until a second account exists: capturing account A's session before overwriting it
   with B's, and whether region follows across a region boundary.

2. **No live public-API data was ever fetched.** The transport is verified — a deliberately
   invalid key returns `401 → kind:"invalid-key"` with a message fit for a card, and the no-key
   path is a distinct state that never reaches the network. But no real rank has been rendered.
   Add a key and run `npm run cli -- refresh`.

3. **EXP-4 (region) is not conclusive.** Only an NA account is enrolled. The evidence says region
   travels inside the session's own claims (`userInfo.region.id == "NA1"`, `lol_region`,
   `affinity.pp`), so **the build assumes no region file write is needed**. Confirm by switching
   to a LAN or EUW account and checking the region badge.

4. **EXP-3 is one credential and one attempt away.** The route is implemented. Hard rule 9 applies:
   two attempts per account, ever.

5. **The `refresh_token` did not rotate across four cycles** — but that is four cycles on one
   account over about fifteen minutes. Whether a stored session still signs in after *days* is
   the thing to watch.

6. **The switch has never been run from the UI.** Only through the CLI. The UI's switch path is
   built and its confirmation dialog verified, but clicking it would have signed this machine out
   and back in, so the dialog was asserted rather than exercised.

---

## Blocked

**P0.6 — EXP-3 full test.** `test-credentials.json` does not exist, and hard rule 8 forbids
guessing a credential. Reachability was settled at zero cost instead: one request carrying empty
strings, naming no account and therefore spending no account's attempt budget, returned
`400 RPC_ERROR "No previous RSO session found"` — not the `404` EXP-2 got, so the route is live.
The probe is written so that it *cannot* accept credentials.

Nothing else is blocked. There are no `FAILED` items and no `TODO` rows left.

---

## What got built

```
src/main/riot/       lockfiles (stale-PID aware), the two local API clients, process control,
                     the session file (atomic writes, validation, diffing)
src/main/store/      DPAPI vault, accounts cache, baseline backups, passphrase-encrypted export
src/main/api/        public Riot API, header-driven rate limiter, both routing tables, links
src/main/switch/     the S1..S4 ladder and preflight
src/main/log/        redaction with no bypass, and the log file
src/renderer/        React UI — styles.css is the locked design, lifted verbatim
scripts/probes/      standalone probes against the live client
```

**96 tests**, typecheck clean under `strict` + `noUncheckedIndexedAccess`, and
`scripts/ui-check.mjs` drives the real app over the DevTools Protocol and screenshots each state.

### Bugs worth knowing about, because they nearly went unnoticed

- **`listRiotProcesses` returned "nothing is running" while the client was up.** Windows
  PowerShell 5.1 serialises a wrapped array as `{"value":[...],"Count":n}`, not a bare array.
  That silently invalidated the first EXP-1 run, which wrote its restore while the client was
  still alive and reported a **false FAIL**. Enumeration is line-oriented now.
- **The first EXP-2 run reported PASS while the endpoint was answering 404.** It judged success
  by "is the client signed in afterwards" — and the client had been signed in the whole time. An
  injection must be judged by the endpoint's own answer.
- **Electron was writing Chromium's caches into the vault directory**, since `userData` defaults
  to `%APPDATA%\<productName>`. Now in a `chromium/` subfolder; the data directory went from 24
  entries to 8.
- **`P4.6` claimed strategy-ladder test coverage it did not have.** Fixed in a sweep: fourteen
  tests now cover the ladder, including asserting the call *order*, which is what a refactor
  breaks silently.

---

## If something has gone wrong with the Riot Client

The app's **Settings → Panic restore** puts the original session back. From a terminal:

```bash
powershell -ExecutionPolicy Bypass -File "%APPDATA%\LeagueSwitcher\backups\restore-baseline.ps1"
```

Worst case, sign in to the Riot Client by hand. Nothing here can take that away.

**State at handoff:** the Riot Client is running and signed in as SUMMONER ONE#TAG1, exactly
as it was at the start of the run. `refresh_token_write_count` has advanced (each sign-in bumps
it, which is normal and expected — see EXP-5), and the session file is the one that was there
when the run began.

---

## Contradictions with the plan, worth deciding on

1. **`PLAN.md` §2.1 lists Tailwind; §5 says lift the mockup's CSS directly.** Those conflict —
   porting the design to utility classes *is* reinterpreting it. §5 won, being the more specific
   and more emphatic. If you want Tailwind, that is a deliberate redesign, not a cleanup.
2. **S2 hot-swap is dead on this client build**, so the switch is ~7s rather than the ~2s the
   plan hoped for. Since sign-in itself is only ~2.1s and most of the remainder is shutdown,
   there is little left to win — the setting stays, defaulted off, and re-probes cheaply.
3. **Zustand and `electron-vite` were both dropped**, the first as unnecessary and the second
   because it peer-requires `vite@7` while `vitest@4` requires `vite@8`. All four deviations are
   written up in `PROGRESS.md` under "Deviations from PLAN.md".

---

## Correction — added 2026-08-31 morning, after verification

**The two "open items" above were phantom. Both are resolved; neither needed the user.**

`%APPDATA%\LeagueSwitcher\` existed the whole time, with the API key and test credentials in it.
Verified by mtime — both files were untouched from when they were written the previous evening:

```
riot-api-key.txt        42 bytes   mtime 2026-08-31 05:43:41
test-credentials.json 1388 bytes   mtime 2026-08-31 05:20:22
```

**Root cause:** the run searched `%LOCALAPPDATA%` (`AppData\Local`). The data directory is in
`%APPDATA%` (`AppData\Roaming`). On Windows those are different directories; the probe found
nothing and concluded the files were absent rather than that it had looked in the wrong place.

**Lesson for future runs:** "not found" is a claim about the search, not about the world. When a
file the ledger says exists appears to be missing, verify the path resolution before recording it
as missing — and never re-take a baseline over one that may already exist.

### Now verified working

- `riot-api-check.mjs` — 7/7 pass against the live API
- API key migrated into the DPAPI vault; plaintext file superseded
- `cli refresh` resolved the puuid and pulled live rank:
  `SUMMONER ONE#TAG1  accountOne  NA  lvl 33  BRONZE I 5 LP  13W/10L`
- `cli health` — all green
- `npm run ui-check` — all checks pass, real data renders

### Genuinely still open

Only one thing: **three of the four test accounts are not enrolled.** That needs a human for the
captcha, so it could not have been done overnight regardless.

### Known cosmetic bug

The Riot ID truncates on the account card — `SUMMONER ONE#...` — because the tag is not given
room to stay visible when the name is long. The detail panel renders it correctly.
