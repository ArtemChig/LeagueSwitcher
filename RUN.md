# Overnight run — paste this into the loop

> **Internal**: how the unattended build session was driven. Of no use unless you are rerunning
> that experiment.

Paste the block below as the loop's prompt. It is written to be re-entrant: every firing re-reads
state from disk, so a context reset loses nothing.

---

```
You are building LeagueSwitcher autonomously overnight. The user is asleep and cannot answer
questions.

FIRST, EVERY TIME — re-read these, in this order:
  1. docs/OVERNIGHT-PROTOCOL.md   (how to work; the PRIME DIRECTIVE)
  2. PROGRESS.md                  (what is actually done — source of truth)
  3. PLAN.md                      (what to build; §6 phases, §7 hard rules)
  4. docs/RESEARCH.md             (verified facts — do NOT re-derive these)

Then pick the first unchecked task in PROGRESS.md and do it.

DO NOT STOP. The run ends only when every PROGRESS.md task is DONE or BLOCKED, and a full sweep
pass finds nothing left. Specifically:
  - Task failed?      Record actual error text, take the documented fallback, move on.
  - Task blocked?     Mark BLOCKED, move to the next INDEPENDENT task, keep going.
  - Question arose?   Write it under "Needs morning verification", assume the documented
                      default, keep going. Never wait for the user.
  - Gate failed?      Don't advance that phase — go do parallel work in another phase.
  - Feels done?       It isn't until the ledger says so. Start another sweep pass.

Never end a turn without either completing a task or recording in PROGRESS.md why you could not.
Update PROGRESS.md as work completes, not in batches.

HARD RULES (violating these is worse than making no progress):
  - Max 2 login attempts per account, ever. Then BLOCKED. No username variants, no retry loops.
  - Never switch accounts while League of Legends.exe is running.
  - Capture a session into the vault before overwriting it, always.
  - Never log tokens, passwords, API keys, or lockfile passwords.
  - Nothing sensitive in the repo — runtime data lives in %APPDATA%\LeagueSwitcher\.
  - Commit locally, never push.
  - Do not attempt hCaptcha solving.
  - Do not invent endpoints — re-pull /swagger/v3/openapi.json and check.
  - Only mark DONE what you actually ran. Reading code is not verification.

When a full sweep finds nothing left, write HANDOFF.md and stop.
```

---

## State on disk before the run

| Thing | Status |
|---|---|
| Baseline backup | ✅ `%APPDATA%\LeagueSwitcher\backups\baseline-20260831-054810\` |
| Restore script | ✅ `%APPDATA%\LeagueSwitcher\backups\restore-baseline.ps1` (syntax-checked) |
| Riot API key | ✅ Permanent personal key, validated end-to-end |
| Test credentials | ✅ 4 accounts, `%APPDATA%\LeagueSwitcher\test-credentials.json` |
| Enrolled sessions | ⚠️ **1** (SUMMONER ONE#TAG1) — see below |
| UI design | ✅ Locked — `docs/mockup.html` |

## The one real dependency

Only **one** account has a captured session. Phase 1's gate is a switch *between two* accounts.

The run's path to a second account is **EXP-3**: does the legacy
`PUT /rso-auth/v1/session/credentials` still work without a captcha? Its schema has no captcha
field, so it may.

- **If EXP-3 passes** — the run enrols all 4 test accounts itself and fully verifies switching.
  Best case; the night is complete.
- **If EXP-3 fails** — hCaptcha blocks headless enrolment. The run can still verify the mechanism
  by round-tripping SUMMONER ONE against itself (capture → wipe → restore → confirm auto-login),
  which proves S1 works. Multi-account switching then waits for you to enrol a second account via
  the assisted flow in the morning.

Either way the night is productive. EXP-3 just determines whether switching is *proven* or merely
*implemented* by morning.

## First thing in the morning

```bash
cat HANDOFF.md
```

If anything went wrong with the Riot Client:

```bash
powershell -ExecutionPolicy Bypass -File "$env:APPDATA\LeagueSwitcher\backups\restore-baseline.ps1"
```
