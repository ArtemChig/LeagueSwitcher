# Overnight Autonomous Execution Protocol

> **Internal**: rules for the unattended build session. Not needed to use or build the app.

Rules for a self-refreshing CLI working through [`PLAN.md`](../PLAN.md) unattended.
The context window **will** reset several times. This document exists so a fresh context resumes
without losing the thread, repeating destructive work, or stopping early.

---

## THE PRIME DIRECTIVE

**Do not stop.** The run ends only when every task in [`PROGRESS.md`](../PROGRESS.md) is `DONE` or
`BLOCKED`. Nothing else terminates it.

In particular, **never** stop for any of these:

- A task failed → record it, take the fallback, move on
- A task is blocked → mark `BLOCKED`, **move to the next independent task**
- A question arose → write it under "Needs morning verification", assume the documented default,
  keep going
- A phase gate failed → do not advance that phase, but there is always parallel work in another
  phase; go do it
- The work "feels" done → it is not done until the ledger says so. Re-read `PROGRESS.md` and start
  another sweep pass
- Uncertainty about scope → the plan is the scope; do the next unchecked item

**Never end a turn without either completing a task or recording in `PROGRESS.md` why you could
not.** A turn that ends with neither is a stalled run.

**Never ask the user a question and wait.** They are asleep. Record it and proceed.

---

## Resume procedure — run this at the start of EVERY context

1. Read `PLAN.md` §6 (phases) and §7 (hard rules).
2. Read `PROGRESS.md` — the single source of truth for what is done.
3. Read `docs/RESEARCH.md` §7 and §9 — experiment outcomes and verified API facts.
   **Do not re-run a completed experiment or re-derive a recorded fact.**
4. Confirm the baseline backup still exists at `%APPDATA%\LeagueSwitcher\backups\baseline-*\`.
5. If a task is marked `DOING`, it was interrupted — verify its real state on disk before continuing.
6. Pick the first unchecked task and continue.

---

## Pass structure

Work in passes. Each pass has an exit condition. When a pass exits, immediately begin the next —
**do not stop between passes.**

| Pass | Scope | Exit condition |
|---|---|---|
| **1** | Phase 0 — safety + experiments | All EXP recorded in RESEARCH §7 as pass or fail |
| **2** | Phase 1 — core engine | `npm run cli -- switch <id>` performs a real switch |
| **3** | Phase 2 — data layer | All enrolled accounts populate on launch from the live API |
| **4** | Phase 4 — hardening + tests | Redaction tests pass; edge cases handled |
| **5** | Phase 3 — UI | Grid + detail panel + switch flow usable end-to-end |
| **6** | Phase 5 — packaging | Portable exe builds; README written |
| **7+** | **Sweep passes** | Repeat until a full sweep finds nothing left |

### Sweep passes (pass 7 onward)

Once passes 1–6 are through, do not stop. Loop:

1. Re-read `PROGRESS.md` top to bottom.
2. Pick up every `TODO` and retry every `FAILED` whose blocker may have since been resolved.
3. Re-run the full test suite and `node scripts/probes/riot-api-check.mjs`.
4. Improve what exists: error handling, edge cases, test coverage, missing states in the UI
   (empty grid, offline, API key invalid, unranked, brand-new account with no matches).
5. Re-read the code you wrote earlier with fresh eyes and fix what is wrong.

A sweep that finds nothing to do ends the run. Write `HANDOFF.md` and stop **then**, not before.

Phase 3 (UI) is deliberately late: it is the most forgiving work for a tired context and the easiest
to review in the morning. If the night runs short, a working engine with a rough UI beats a
beautiful UI over an unproven engine.

---

## Ledger discipline

Update `PROGRESS.md` **as work completes, not in batches.** A context reset between doing the work
and recording it means the work gets redone — or worse, a destructive step repeats.

Record: task ID, status, timestamp, what was verified, any deviation from the plan.
Status: `TODO` · `DOING` · `DONE` · `BLOCKED` · `FAILED`. Only one `DOING` at a time.

**Never mark `DONE` what was not actually run.** A plausible implementation that was never executed
is `TODO`. Verification means running it, not reading it.

---

## Safety invariants

These hold at every point:

- **The baseline backup exists** before any write to `%LOCALAPPDATA%\Riot Games\`.
  Already created: `%APPDATA%\LeagueSwitcher\backups\baseline-20260831-054810\`
  (SUMMONER ONE#TAG1). Restore with
  `powershell -ExecutionPolicy Bypass -File "%APPDATA%\LeagueSwitcher\backups\restore-baseline.ps1"`
- **Capture before overwrite, always.** Never destroy a live session without a vault copy.
- **Max 2 login attempts per account, ever.** Then `BLOCKED`. No username variants, no retry loops.
  Repeated auth failures are how accounts get locked. Honour `retryAfter`.
- **Never switch accounts while a game is running** (`League of Legends.exe`).
- **Nothing sensitive in the repo.** Runtime data lives in `%APPDATA%\LeagueSwitcher\`.
- **Never log** a token, password, API key, or lockfile password.
- **Commit locally, never push.** Pushing is the user's decision.
- **Do not attempt hCaptcha solving.** Out of scope by decision.
- **Do not invent endpoints.** Re-pull `/swagger/v3/openapi.json`; the spec is live.

---

## Handling failure

1. Record it as `FAILED` in `PROGRESS.md` with the **actual error text**, not a paraphrase.
2. If `PLAN.md` documents a fallback, take it and note the deviation.
3. If not, mark `BLOCKED`, move to the next independent task, keep going.
4. Do not spin on one problem. Do not delete work to "start clean."
5. Three consecutive failures on the same task = `BLOCKED`. Move on.

---

## Verification standards

- Engine code is verified by **running it**. `scripts/cli.ts` exists so every Phase 1 capability is
  exercisable headlessly.
- API integrations are verified against the **live API**, with the response recorded.
- The public API works right now with a permanent key — **no mocks needed for Phase 2.**
- Anything genuinely unverifiable tonight goes under "Needs morning verification."

---

## Morning handoff

When a full sweep finds nothing left, write `HANDOFF.md`:

- What was completed, by phase
- Every `BLOCKED` / `FAILED` item with its reason and actual error text
- **"Needs morning verification"** — especially anything involving a second account
- Exact commands to try first
- Anything discovered that contradicts `PLAN.md` or `docs/RESEARCH.md`
