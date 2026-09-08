# Riot API key - optional

**You do not need this to switch accounts.** Switching, enrolling, Riot IDs, regions, levels and
profile icons all come from the Riot Client itself and work with no key at all.

A key adds one thing: **rank and match history**, fetched for every account at once so the grid
shows them without signing into each. If that is not worth ten minutes, skip this file - the app
shows a "No Riot API key" banner and is otherwise fully functional.

The key is stored encrypted with Windows DPAPI in `%APPDATA%\LeagueSwitcher\`, and is only ever sent
to Riot as an `X-Riot-Token` header.

Two kinds of key. The development key works immediately and expires every 24 hours; the personal
key never expires but takes a few days to be approved. Get the first to try it now, apply for the
second if you intend to keep using it.

---

## Part 1 — Development key (2 minutes, works immediately)

1. Go to **https://developer.riotgames.com** and sign in with a Riot account.
   Prefer an account you will **not** be switching between — the key belongs to whoever signs in,
   and it is simpler if that account is not one the app logs in and out of.
2. On the dashboard, find the **DEVELOPMENT API KEY** panel.
3. Click **REGENERATE API KEY**, then copy the value. It looks like `RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.
4. Save it:

```bash
echo "RGAPI-paste-your-key-here" > "$APPDATA/LeagueSwitcher/riot-api-key.txt"
```

**It expires 24 hours after generation.** Fine for trying the app out, unusable as a permanent
answer — hence Part 2.

### Verify it works

```bash
curl -s -H "X-Riot-Token: $(cat "$APPDATA/LeagueSwitcher/riot-api-key.txt")" "https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/SUMMONER%20ONE/IDF"
```

A JSON body with a `puuid` means the key is live. `401` means it expired or was mistyped.

---

## Part 2 — Personal key (permanent; apply now, approved in a few days)

1. Go to **https://developer.riotgames.com/app-type**
2. Choose **PERSONAL API KEY**
3. Fill in the application. The fields below are what the form asks for as of writing — if the
   layout has changed, the substance is the same: they want to know what you're building, that it
   isn't public, and that it doesn't monetise their data.

**Suggested answers** — accurate for this app; adjust to fit what you are actually doing:

| Field | Suggested answer |
|---|---|
| Product name | `LeagueSwitcher` |
| Product URL | Your GitHub profile, or `http://localhost` if you have nothing to point at |
| Product description | *A personal desktop utility for switching between my own League of Legends accounts. It reads publicly available summoner and ranked data (level, profile icon, tier, division, LP, win/loss) for the handful of accounts I own, so I can see them at a glance instead of logging into each one. Single user, runs locally on my own PC, not distributed and not monetised.* |
| Who will use it | Just me — single private user |
| Will you monetise | No |
| APIs used | `account-v1`, `summoner-v4`, `league-v4`, `match-v5` |

**Notes that improve approval odds:**

- Be specific that it's **single-user and private**. Personal keys exist exactly for this.
- Don't mention account switching or credential storage. It's irrelevant to the API request —
  the key is only used to read public ranked data — and it invites questions you don't need.
- A real repo URL helps. A private repo is fine; they don't clone it.

Approval typically takes a few days. You'll get an email. The key then appears on your dashboard
and **does not expire**.

### When it arrives

Replace the file contents and restart the app:

```bash
echo "RGAPI-your-permanent-key" > "$APPDATA/LeagueSwitcher/riot-api-key.txt"
```

---

## Rate limits (both key types)

| Window | Limit |
|---|---|
| Per second | 20 requests |
| Per 2 minutes | 100 requests |

Ten accounts × 3 calls = ~30 requests per app launch, roughly a third of the 2-minute budget. The
client in `api/riotApi.ts` implements a token bucket anyway and honours `Retry-After` on any 429,
so bursts during development can't get the key throttled.

---

## Security notes

- The key is a **bearer credential** — anyone with it can make requests as you. Treat it like a
  password.
- Sent as the `X-Riot-Token` header. **Never** as a URL query parameter — it would end up in logs.
- Covered by `.gitignore`, but the real protection is that it lives in `%APPDATA%`, outside the
  working tree entirely.
- The log redactor strips anything matching `RGAPI-[0-9a-f-]{36}` before writing.
