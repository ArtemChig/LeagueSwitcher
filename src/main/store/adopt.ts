/**
 * Rebuild account records from sessions the vault already holds.
 *
 * A stored session can outlive its profile. It happened for real: two enrolments saved a
 * session and a password, reported success, and left no row in accounts.json, because the
 * account store cached its file and a stale snapshot overwrote them. The sessions were intact
 * the whole time — only the metadata was gone.
 *
 * Re-enrolling would have worked but costs a full sign-in and captcha per account for data the
 * machine already has. Everything a profile needs is inside the session's own id_token:
 *
 *   acct.game_name / acct.tag_line   Riot ID
 *   lol[0].uname                     the login username typed at Riot's sign-in screen
 *   lol[0].pid                       platform id, e.g. "NA1" / "LA1"
 *   sub                              the client's local puuid
 *
 * The JWT is read, never verified. It is not a security decision — the token came out of our
 * own DPAPI-encrypted vault, and the worst case for a malformed one is a skipped account.
 */
import { getVault } from "./vault.js";
import { getAccountStore, createAccount, regionFromPlatform, type Account } from "./accounts.js";

export interface AdoptedAccount {
  id: string;
  loginUsername: string;
  riotId: string | null;
  platformId: string | null;
  region: string | null;
}

export interface AdoptReport {
  adopted: AdoptedAccount[];
  skipped: { id: string; reason: string }[];
}

interface IdTokenClaims {
  sub?: string;
  acct?: { game_name?: string; tag_line?: string };
  lol?: { uname?: string; pid?: string }[];
}

/** Pull the id_token out of a session file and decode its payload. Null if unreadable. */
export function claimsFromSession(sessionYaml: string): IdTokenClaims | null {
  const match = sessionYaml.match(/^\s*id_token:\s*"?([A-Za-z0-9._-]+)"?\s*$/m);
  const payload = match?.[1]?.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as IdTokenClaims;
  } catch {
    return null;
  }
}

/**
 * Give every stored session without a profile one built from its own token.
 *
 * Only ever adds; an existing profile is left exactly as it is, so this is safe to run at any
 * time and safe to run twice.
 */
export async function adoptOrphanSessions(): Promise<AdoptReport> {
  const vault = await getVault();
  const store = getAccountStore();

  const report: AdoptReport = { adopted: [], skipped: [] };
  const orphans = vault.listSessionAccountIds().filter((id) => !store.get(id));

  for (const id of orphans) {
    const raw = await vault.getSession(id);
    if (!raw) {
      report.skipped.push({ id, reason: "the stored session could not be read" });
      continue;
    }

    const claims = claimsFromSession(raw);
    if (!claims) {
      report.skipped.push({ id, reason: "no readable id_token in the stored session" });
      continue;
    }

    const lol = claims.lol?.[0];
    // Prefer the username Riot itself recorded; the vault key is only a fallback.
    const loginUsername = lol?.uname ?? id;
    const platformId = lol?.pid ?? null;
    const gameName = claims.acct?.game_name ?? null;
    const tagLine = claims.acct?.tag_line ?? null;

    // Keep the vault key as the id, or the session would no longer be findable.
    const account: Account = createAccount(id, loginUsername, {
      gameName,
      tagLine,
      platformId,
      region: platformId ? regionFromPlatform(platformId) : null,
      localPuuid: claims.sub ?? null,
      order: store.list().length,
      enrolledAt: new Date().toISOString(),
      // Rank and level need the public API; `refresh` fills them in.
      sessionHealth: "valid",
    });

    store.upsert(account);
    report.adopted.push({
      id,
      loginUsername,
      riotId: gameName ? `${gameName}#${tagLine ?? ""}` : null,
      platformId,
      region: account.region,
    });
  }

  return report;
}
