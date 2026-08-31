/**
 * P3.2 — the account card. A direct port of the mockup's card markup.
 *
 * The locked hierarchy (PLAN §5), which must not be revisited:
 *   Riot ID is the largest element on the card. Rank is one compact line beneath it. Tier
 *   colour drives the top stripe, border, hover glow, avatar ring and win-rate bar — so the
 *   grid still reads by rank at a glance without rank consuming the space.
 *
 * What the mockup did not have to handle, and this does: a missing profile icon, an account
 * with no Riot ID yet, an unranked account, an account whose refresh failed, and skeletons
 * while the launch refresh is still in flight.
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { AccountView } from "../../shared/ipc.js";
import { Crest, normaliseTier } from "../crests.js";
import { useFitText } from "../useFitText.js";

interface Props {
  account: AccountView;
  loading: boolean;
  onSwitch: (account: AccountView) => void;
  onDetails: (account: AccountView) => void;
  onRetry: (account: AccountView) => void;
}

/** Deterministic hue from the login name, so an account without an icon still looks distinct. */
function hue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "?").slice(0, 2).toUpperCase();
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function AccountCard({ account, loading, onSwitch, onDetails, onRetry }: Props): JSX.Element {
  // Scale the Riot ID to fit rather than truncating it: the name is the card, and two
  // smurfs sharing a prefix are indistinguishable once it is cut off.
  const fit = useFitText<HTMLDivElement>(account.riotIdLabel, { max: 1.35, min: 0.95 });

  const tier = normaliseTier(account.tierKey);
  const [icon, setIcon] = useState<string | null>(null);

  // The icon is fetched through IPC as a data URI — the renderer has no filesystem access.
  useEffect(() => {
    let cancelled = false;
    if (account.profileIconId === null) {
      setIcon(null);
      return;
    }
    void window.api
      .getIcon(account.profileIconId)
      .then((uri) => {
        if (!cancelled) setIcon(uri);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [account.profileIconId]);

  const healthTitle =
    account.sessionHealth === "valid"
      ? "Session valid"
      : account.sessionHealth === "stale"
        ? "Session expiring soon — switch to it or re-enrol"
        : "No stored session — this account needs enrolling";

  const played = account.wins + account.losses;

  return (
    <div
      className="card"
      style={{ ["--tier" as string]: `var(--${tier})` }}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        const action = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
        if (action?.dataset.act === "switch") {
          e.stopPropagation();
          onSwitch(account);
          return;
        }
        if (action?.dataset.act === "retry") {
          e.stopPropagation();
          onRetry(account);
          return;
        }
        onDetails(account);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onDetails(account);
        }
      }}
    >
      <span
        className={`health${account.sessionHealth === "valid" ? "" : account.sessionHealth === "stale" ? " stale" : " missing"}`}
        title={healthTitle}
        style={
          account.sessionHealth === "missing"
            ? { background: "#E08582", boxShadow: "0 0 0 3px rgba(224,133,130,.18)" }
            : undefined
        }
      />

      <div className="card-body">
        <div className="idrow">
          <div
            className="pfp"
            style={
              icon
                ? { backgroundImage: `url(${icon})`, backgroundSize: "cover", backgroundPosition: "center" }
                : {
                    background: `linear-gradient(140deg,hsl(${hue(account.loginUsername)} 42% 62%),hsl(${(hue(account.loginUsername) + 40) % 360} 38% 44%))`,
                  }
            }
          >
            {icon ? "" : initials(account.gameName ?? account.loginUsername)}
            <span className="lvl">
              {account.summonerLevel ?? (loading ? <i className="skel" style={{ width: "1.2rem", height: ".6em" }} /> : "—")}
            </span>
          </div>

          <div className="names">
            <div className="riotid" title={account.riotIdLabel} ref={fit.ref} style={{ fontSize: fit.fontSize }}>
              {account.gameName ? (
                <>
                  {account.gameName}
                  <span className="tag">#{account.tagLine}</span>
                </>
              ) : (
                <span style={{ color: "var(--ink-2)" }}>{account.loginUsername}</span>
              )}
            </div>
            <div className="login" title={account.loginUsername}>
              {account.loginUsername}
            </div>
          </div>
        </div>

        <div className="rank-row">
          <Crest tier={tier} />
          <span className="tier">
            {loading && account.ranked.length === 0 ? <i className="skel skel-line" /> : account.rankLabel}
          </span>
          <span className="lp">
            {account.leaguePoints !== null ? (
              <>
                <b>{account.leaguePoints}</b> LP
              </>
            ) : (
              // An unranked account shows placements rather than a meaningless 0 LP.
              <>
                <b>{Math.min(played, 5)}</b>/5 placements
              </>
            )}
          </span>
          <span className="region" style={{ marginLeft: "auto" }}>
            {account.region ?? "—"}
          </span>
        </div>

        <div className="meta">
          <span className="wl" style={{ marginLeft: 0 }}>
            {played > 0 ? (
              <>
                <b>{account.wins}</b>W {account.losses}L &middot; {account.winRate}% WR
              </>
            ) : (
              <span style={{ color: "var(--ink-3)" }}>No ranked games yet</span>
            )}
          </span>
        </div>

        <div className="bar">
          <span style={{ width: `${account.winRate ?? 0}%` }} />
        </div>

        {account.lastError && (
          <div className="carderr">
            <span title={account.lastError}>{account.lastError}</span>
            <button type="button" data-act="retry">
              Retry
            </button>
          </div>
        )}

        <div className="cardbar">
          <button
            className="cbtn go"
            data-act="switch"
            type="button"
            disabled={!account.hasStoredSession || account.isActive}
            title={
              account.isActive
                ? "This account is already signed in"
                : account.hasStoredSession
                  ? undefined
                  : "This account has no stored session yet"
            }
            style={
              !account.hasStoredSession || account.isActive
                ? { opacity: 0.45, cursor: "not-allowed" }
                : undefined
            }
          >
            {account.isActive ? "Signed in" : "Switch"}
          </button>
          <button className="cbtn" data-act="details" type="button">
            Details
          </button>
        </div>
      </div>
    </div>
  );
}
