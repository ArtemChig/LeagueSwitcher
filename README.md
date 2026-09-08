# LeagueSwitcher

Switch between League of Legends accounts in one click, with a dashboard of rank, level, region
and quick links. Windows, portable single `.exe`, no installer.

A switch takes about **8 seconds** and needs no password and no captcha.

---

## Get started

1. **[Download the latest release](../../releases/latest)** — one `.exe`, nothing to install.
2. Run it. Windows SmartScreen will warn because the build is unsigned: **More info → Run anyway.**
3. On first run it takes a safety snapshot of your current Riot login, then captures whichever
   account you are already signed in as.
4. **Add account** for each of the others. It opens a clean Riot sign-in; you complete it once,
   including the captcha, and the session is captured. After that, switching to that account never
   asks for a password again.

Optionally, to launch it by typing "leagueswitcher" into Start:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

### What you need

- **Windows** — this reads the Riot Client's own files and drives PowerShell. There is no
  macOS or Linux build, and there will not be one.
- **The Riot Client installed.** Any drive; the app reads Riot's own install manifest to find it.
- **Nothing else.** No API key, no account, no sign-up.

A [Riot API key](docs/API-KEY-SETUP.md) is **optional** and adds rank and match history for every
account at once. Without one the app still shows Riot ID, region, level and profile icon, all read
from the Riot Client directly.

### Your data stays yours

Passwords and sessions are encrypted with Windows DPAPI in `%APPDATA%\LeagueSwitcher\` — readable
only by your Windows user, on your machine. Nothing is uploaded anywhere. The only network calls
are to Riot's own public API, and only if you add a key.

---

## How it actually works

The instinctive design for an account switcher is "store the password, replay it on demand."
That path is closed: Riot issues an **hCaptcha challenge on every login**, confirmed in this
machine's own client telemetry. No headless password replay survives that without a paid captcha
solver, which would be fragile and permanently one patch away from breaking.

The design that does work is better anyway.

The Riot Client keeps its login in
`%LOCALAPPDATA%\Riot Games\Riot Client\Data\RiotGamesPrivateSettings.yaml`. That file holds a
long-lived OAuth **refresh token** which is *not* device-bound (`is_dpop_bound: false`) and stays
valid for roughly **453 days** between uses. So:

1. **Enrol an account once** — sign in normally, while you are there to clear the captcha.
2. The app **captures that session file** into an encrypted vault.
3. **Every switch after that** is: save the current session, close the client, write the target
   session back, relaunch. No password, no captcha, no network authentication.

Measured on the development machine: **~2.1 s** from launch to signed-in, ~7 s for the whole
switch including shutdown.

### What was measured, not assumed

Everything above was verified against a real client before any of it was built. The experiments
and their actual responses are in [`docs/RESEARCH.md`](docs/RESEARCH.md) §7. Two findings changed
the design:

- **The client's OpenAPI spec is a superset of what it implements.** A route can be fully
  documented, with request and response schemas, and still answer `404 RPC_ERROR "Not Found"`.
  The hot-swap endpoint that would have made switches instant is exactly this case, so the fast
  path is disabled by default and the code falls through to the file swap.
- **The Riot Client identifies the account itself** — Riot ID, login username, region, summoner
  level and profile icon, with no API key and without launching League. That is why the app is
  useful even with no Riot API key configured.

---

## Setup

1. Run `LeagueSwitcher-<version>-portable.exe`.
2. The first-run screen asks for two things, in this order:
   - **Take a safety snapshot.** Copies your current Riot session file so the original can always
     be put back. It only reads; nothing is changed.
   - **Capture the signed-in account.** Stores that session so you can return to it.
3. To add accounts you are *not* signed in as: **+ Add account → Sign in to add**. The client
   opens at a clean sign-in screen with the username prefilled; you sign in once, captcha
   included, and the session is captured the moment it appears.

### Optional: a Riot API key

Without a key the app still shows Riot ID, login username, region, level and profile icon — all
of it read from the Riot Client. A key adds **rank** and match history.

Get a **personal** key from [developer.riotgames.com](https://developer.riotgames.com) (no expiry;
a *development* key expires every 24 hours and is not worth it), then paste it into
**Settings → Riot API key**. It is stored encrypted and never displayed again.

---

## Where things are kept

Nothing sensitive is ever written into the application folder.

```
%APPDATA%\LeagueSwitcher\
  accounts.json     profile metadata and cached stats — no secrets, so the UI can render instantly
  secrets.enc       DPAPI-encrypted passwords and API key
  sessions\<id>.enc DPAPI-encrypted copy of each account's session file
  backups\          safety snapshots — never rotated or deleted automatically
  cache\            profile icons and rank crests
  logs\app.log      redacted; the logger has no way to write an unredacted line
```

Encryption is Windows DPAPI, scoped to your Windows user account. A vault copied to another
machine, or opened by another user on this one, is unreadable. That is also why
**Settings → export** uses a passphrase instead: a DPAPI blob deliberately cannot travel.

---

## Safety

This app rewrites the file the Riot Client authenticates from, so the guarantees matter more than
the features:

- **A game in progress refuses a switch outright.** Not a warning — a refusal.
- **An open League client asks first**, naming the account that will be signed out.
- **The current session is captured before anything is overwritten**, always.
- **The target session is verified before anything is touched.** If it will not decrypt, the
  switch stops with your existing session untouched.
- **Session writes are atomic** (temp file, then rename), so a crash mid-write cannot leave a
  truncated file that signs you out of everything.
- **Panic restore** (Settings) puts the original snapshot back and is behind a typed confirmation.
- **League is never launched by a switch.** The switch ends at the Riot Client; you start the game.

---

## An honest note on Riot's terms

Automating the Riot Client is not something Riot formally sanctions. Account switchers are
widespread and long-lived, and none of this grants a gameplay advantage, reads or writes game
memory, or automates anything in a match — it copies a file the client itself wrote and restarts
that client. Practical risk is low, but it is not zero, and Riot can break the mechanism in any
patch.

Two things this app deliberately will not do:

- **It does not attempt to solve captchas.** Out of scope by decision, not by oversight.
- **It never retries a failed login.** Repeated auth failures are how accounts get locked, so the
  password paths are capped and `retryAfter` is honoured.

Use it on your own accounts.

---

## Building from source

```bash
npm install
npm run build          # renderer via vite, main/preload via esbuild
npm start              # build and run
npm run dist           # portable .exe into release/
```

Assets are fetched once and committed, so a build needs no network:

```bash
npm run crests         # Riot's rank mini-crests -> assets/crests/
npm run fonts          # the three locked typefaces -> src/renderer/fonts/
npm run icon           # app icon -> build/icon.png
```

### Verifying

```bash
npm test               # 82 tests: redaction, logger-to-disk, session, vault, routing
npm run typecheck
npm run ui-check       # drives the real app over the DevTools Protocol and screenshots it
npm run scan-secrets   # also runs as a pre-commit hook
```

The engine is fully usable without the GUI, which is how it was built and verified:

```bash
npm run cli -- status          # what is running, who is signed in
npm run cli -- list
npm run cli -- capture         # store the signed-in account
npm run cli -- switch <who>    # --yes to close a running client
npm run cli -- preflight <who> # what would stop a switch right now
npm run cli -- health          # environment, vault and per-account diagnostics
npm run cli -- export <file> --passphrase <p>
```

There are also standalone probes in `scripts/probes/` that talk to the live Riot Client — these
are what produced the findings in `docs/RESEARCH.md`, and re-running them is the way to check
whether a Riot update has changed something:

```bash
node scripts/probes/client-status.mjs     # read-only
node scripts/probes/swagger-dump.mjs      # re-pull the live API spec and check dependencies
```

---

## If something goes wrong

**Settings → Panic restore** puts the original session back. From a terminal:

```bash
powershell -ExecutionPolicy Bypass -File "%APPDATA%\LeagueSwitcher\backups\restore-baseline.ps1"
```

Worst case, sign in to the Riot Client by hand — nothing here can take that away, and the app
will pick the session back up.

---

## Project layout

```
src/main/riot/       lockfiles, local API clients, process control, the session file
src/main/store/      DPAPI vault, accounts cache, backups, portable export
src/main/api/        public Riot API, rate limiter, routing tables, links
src/main/switch/     the S1..S4 strategy ladder
src/main/log/        redaction (no bypass) and the log file
src/renderer/        React UI; styles.css is the locked design, lifted verbatim
scripts/probes/      standalone probes against the live client
```

Design and rationale: [`PLAN.md`](PLAN.md) · verified facts: [`docs/RESEARCH.md`](docs/RESEARCH.md) ·
what was actually done: [`PROGRESS.md`](PROGRESS.md).

---

## Install

Grab the portable `.exe` from [Releases](../../releases), or build it:

```bash
npm install
npm run dist
```

To get it into Start-menu search — type "leagueswitcher", press Enter:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

That copies the exe to `%LOCALAPPDATA%\Programs\LeagueSwitcher` and adds Start-menu and desktop
shortcuts. It copies rather than shortcutting into `release\`, because `npm run dist` wipes that
directory on every build. `-Uninstall` reverses it and leaves your vault alone.

---

## Licence and disclaimer

MIT — see [LICENSE](LICENSE).

**Not affiliated with, endorsed by, or sponsored by Riot Games.** League of Legends and Riot
Games are trademarks of Riot Games, Inc. This is a personal utility that reads the Riot Client's
own local API and Riot's public developer API. It grants no gameplay advantage, does not touch
game memory, and does not modify the game. Automating the Riot Client is not something Riot
formally sanctions, and a patch can break the mechanism at any time — the switch ladder in
`PLAN.md` §3 is layered so that it degrades rather than dies.

Account data stays on your machine: passwords and sessions are encrypted with Windows DPAPI in
`%APPDATA%\LeagueSwitcher\`, never in this repository.
