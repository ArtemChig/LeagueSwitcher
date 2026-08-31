/**
 * P3.5 — the account detail slide-over. Design locked (PLAN §5); this is the mockup's panel.
 *
 * Sections, in the specified order: header, account data, look up, credentials, actions.
 *
 * The credentials section is the one with real behaviour behind it. It is how the user rotates
 * a password after changing it on Riot's site, and the hint text has to be exact about what
 * saving does — it writes to the encrypted vault and nothing else. It does not re-authenticate,
 * and the existing session keeps working. If Riot invalidated that session when the password
 * changed, Re-enrol is the fix. Getting this wrong would have people believe a save had
 * repaired an account when it had not.
 *
 * The password is only fetched from the vault when the user presses Show, so it is not sitting
 * in renderer memory merely because a panel is open.
 */
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import type { AccountView } from "../../shared/ipc.js";
import { Crest, normaliseTier } from "../crests.js";

interface Props {
  account: AccountView | null;
  onClose: () => void;
  onSwitch: (account: AccountView) => void;
  onReenrol: (account: AccountView) => void;
  onDelete: (account: AccountView) => void;
  onToast: (message: string, isError?: boolean) => void;
}

export function DetailPanel({ account, onClose, onSwitch, onReenrol, onDelete, onToast }: Props): JSX.Element {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Reset per account, and never carry one account's password into another's panel.
  useEffect(() => {
    setUsername(account?.loginUsername ?? "");
    setPassword("");
    setRevealed(false);
    setDirty(false);
    // preventScroll matters: the panel is a scroll container, and focusing the close button
    // without it scrolls the header (avatar, Riot ID, rank row) out of view every time the
    // panel opens, so it appears to open half-way down.
    if (account) closeRef.current?.focus({ preventScroll: true });
  }, [account?.id]);

  if (!account) {
    return (
      <>
        <div className="panel-scrim" data-open="false" />
        <aside className="panel" data-open="false" aria-hidden="true" />
      </>
    );
  }

  const tier = normaliseTier(account.tierKey);

  async function reveal(): Promise<void> {
    if (revealed) {
      setRevealed(false);
      return;
    }
    const stored = await window.api.getCredentials(account!.id);
    if (!stored) {
      onToast("No password is stored for this account yet.");
      setRevealed(true);
      return;
    }
    setUsername(stored.username);
    setPassword(stored.password);
    setRevealed(true);
  }

  async function save(): Promise<void> {
    if (!username.trim()) {
      onToast("A login username is required.", true);
      return;
    }
    setSaving(true);
    try {
      await window.api.saveCredentials(account!.id, username.trim(), password);
      setDirty(false);
      onToast("Credentials saved to the encrypted vault.");
    } catch (err) {
      onToast(`Could not save: ${(err as Error).message}`, true);
    } finally {
      setSaving(false);
    }
  }

  const stats: Array<[string, string]> = [
    ["Level", account.summonerLevel !== null ? String(account.summonerLevel) : "—"],
    ["Region", account.region ?? "—"],
    ["Solo/duo", account.rankLabel],
    ["LP", account.leaguePoints !== null ? String(account.leaguePoints) : "—"],
    ["Record", account.wins + account.losses > 0 ? `${account.wins}W ${account.losses}L` : "No games"],
    ["Win rate", account.winRate !== null ? `${account.winRate}%` : "—"],
    [
      "Session",
      account.sessionHealth === "valid"
        ? `Valid${account.sessionDaysRemaining !== null ? ` · ${account.sessionDaysRemaining}d` : ""}`
        : account.sessionHealth === "stale"
          ? "Expiring soon"
          : "Needs re-enrolment",
    ],
    ["Last switched", account.lastSwitchedAt ? new Date(account.lastSwitchedAt).toLocaleDateString() : "Never"],
  ];

  return (
    <>
      <div className="panel-scrim" data-open="true" onClick={onClose} />
      <aside
        className="panel"
        data-open="true"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ptitle"
        style={{ ["--tier" as string]: `var(--${tier})` }}
      >
        <div className="panel-head">
          <button className="pclose" ref={closeRef} aria-label="Close" onClick={onClose}>
            &times;
          </button>
          <div className="idrow">
            <div className="pfp" style={{ background: `linear-gradient(140deg,var(--surface-3),var(--surface-2))` }}>
              {(account.gameName ?? account.loginUsername).slice(0, 2).toUpperCase()}
              <span className="lvl">{account.summonerLevel ?? "—"}</span>
            </div>
            <div className="names">
              <div className="riotid" id="ptitle">
                {account.gameName ? (
                  <>
                    {account.gameName}
                    <span className="tag">#{account.tagLine}</span>
                  </>
                ) : (
                  account.loginUsername
                )}
              </div>
              <div className="login">{account.loginUsername}</div>
            </div>
          </div>
          <div className="rank-row">
            <Crest tier={tier} />
            <span className="tier">{account.rankLabel}</span>
            <span className="lp">
              {account.leaguePoints !== null ? (
                <>
                  <b>{account.leaguePoints}</b> LP
                </>
              ) : (
                "—"
              )}
            </span>
            <span className="region" style={{ marginLeft: "auto" }}>
              {account.region ?? "—"}
            </span>
          </div>
        </div>

        <div className="psect">
          <p className="plabel">Account data</p>
          <div className="stats">
            {stats.map(([k, v]) => (
              <div className="stat" key={k}>
                <div className="k">{k}</div>
                <div className="v">{v}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="psect">
          <p className="plabel">Look up</p>
          {account.links.length === 0 ? (
            <p className="hint" style={{ margin: 0 }}>
              No Riot ID for this account yet. Switch to it once and the Riot Client reports its own Riot ID.
            </p>
          ) : (
            <div className="links">
              {account.links.map((link) => (
                <a
                  className="link"
                  key={link.id}
                  href={link.url}
                  onClick={(e) => {
                    e.preventDefault();
                    void window.api.openExternal(link.url);
                  }}
                >
                  {link.label}
                </a>
              ))}
            </div>
          )}
        </div>

        <div className="psect">
          <p className="plabel">Credentials</p>
          <div className="field">
            <label htmlFor="f-user">Login username</label>
            <div className="inwrap">
              <input
                id="f-user"
                type="text"
                spellCheck={false}
                autoComplete="off"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setDirty(true);
                }}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="f-pass">Password</label>
            <div className="inwrap">
              <input
                id="f-pass"
                type={revealed ? "text" : "password"}
                autoComplete="off"
                placeholder={account.hasStoredPassword ? "••••••••••••" : "No password stored"}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setDirty(true);
                }}
              />
              <button className="reveal" type="button" onClick={() => void reveal()}>
                {revealed ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          <div className="pactions" style={{ marginTop: ".8rem" }}>
            <button className="pbtn" onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save credentials"}
            </button>
          </div>
          <p className="hint">
            Changing the password here updates the stored copy only. The saved session keeps working — but if Riot
            invalidated it when you changed the password, use <b>Re-enrol</b> below.
          </p>
        </div>

        <div className="psect">
          <p className="plabel">Actions</p>
          <div className="pactions">
            <button
              className="pbtn primary"
              onClick={() => onSwitch(account)}
              disabled={!account.hasStoredSession || account.isActive}
            >
              {account.isActive ? "Currently signed in" : "Switch to this account"}
            </button>
          </div>
          <div className="pactions" style={{ marginTop: ".5rem" }}>
            <button className="pbtn" onClick={() => onReenrol(account)}>
              Re-enrol session
            </button>
            <button className="pbtn danger" onClick={() => onDelete(account)}>
              Delete
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
