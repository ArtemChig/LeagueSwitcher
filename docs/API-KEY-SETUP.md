# Riot API Key — setup guide

Two keys, two purposes. Get the development key in the next two minutes so tonight's build has
something live to test against; submit the personal key application in the next ten so it's
approved in a few days.

Neither key ever goes in the repo. Both live at
`%APPDATA%\LeagueSwitcher\riot-api-key.txt` (plaintext for now, migrated into the DPAPI-encrypted
vault at task P1.5).

---

## Part 1 — Development key (2 minutes, works immediately)

1. Go to **https://developer.riotgames.com** and sign in with any Riot account.
   Use your **main account**, not one of the four test accounts — the key is tied to whoever signs
   in, and you don't want it bound to an account the switcher is about to log in and out of.
2. On the dashboard, find the **DEVELOPMENT API KEY** panel.
3. Click **REGENERATE API KEY**, then copy the value. It looks like `RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.
4. Save it:

```bash
echo "RGAPI-paste-your-key-here" > "$APPDATA/LeagueSwitcher/riot-api-key.txt"
```

**It expires 24 hours after generation.** That is fine for testing tonight and unusable as a
permanent answer — hence Part 2.

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

**Suggested answers** — accurate for this project, adjust freely:

| Field | Suggested answer |
|---|---|
| Product name | `LeagueSwitcher` |
| Product URL | Your private GitHub repo URL, or `http://localhost` if the repo isn't up yet |
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
