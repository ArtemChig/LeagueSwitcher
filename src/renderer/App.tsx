/**
 * P3.2 / P3.7 — the shell: toolbar, active strip, grid, and the keyboard map.
 *
 * Ported from docs/mockup.html. The DOM structure and class names are the mockup's, so the
 * lifted stylesheet applies unchanged.
 *
 * The states the mockup did not have to show are handled here, because they are what the app
 * actually spends its time in: nothing enrolled yet, a refresh still in flight, no API key, an
 * account whose refresh failed, and a Riot Client that is not running.
 */
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AccountView, AppStatus, Preflight } from "../shared/ipc.js";
import { AccountCard } from "./components/AccountCard.js";
import { DetailPanel } from "./components/DetailPanel.js";
import { SwitchModal } from "./components/SwitchModal.js";
import { EnrolModal } from "./components/EnrolModal.js";
import { SettingsModal } from "./components/SettingsModal.js";
import { FirstRun } from "./components/FirstRun.js";
import { CrestSprite, Crest, normaliseTier } from "./crests.js";

type SortMode = "rank" | "name" | "recent";

export function App(): JSX.Element {
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("rank");
  const [regionFilter, setRegionFilter] = useState<string>("All");

  const [detail, setDetail] = useState<AccountView | null>(null);
  const [switching, setSwitching] = useState<{ account: AccountView; preflight: Preflight | null } | null>(null);
  const [enrolOpen, setEnrolOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((message: string, error = false) => {
    setToast({ message, error });
    setTimeout(() => setToast(null), 4200);
  }, []);

  const reload = useCallback(async () => {
    const [list, appStatus] = await Promise.all([window.api.listAccounts(), window.api.getStatus()]);
    setAccounts(list);
    setStatus(appStatus);
    setLoading(false);
    // Keep an open panel in step with refreshed data rather than showing a stale copy.
    setDetail((current) => (current ? (list.find((a) => a.id === current.id) ?? null) : null));
  }, []);

  useEffect(() => {
    void reload();

    // Polling exists because the launch refresh runs in main and lands after the first paint,
    // and because "is the Riot Client running" changes behind the app's back. It is kept at a
    // slow cadence and paused while the window is hidden: each poll enumerates processes in
    // main, and there is nothing to show while nobody is looking.
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      timer ??= setInterval(() => void reload(), 10_000);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        void reload();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);

    // Main pushes this when the launch refresh lands, so new data appears immediately rather
    // than on the next poll.
    const unsubscribe = window.api.onAccountsChanged(() => void reload());

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
    };
  }, [reload]);

  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    try {
      await window.api.collect();
      const outcome = await window.api.refresh();
      if (!outcome.ran && outcome.skippedReason === "no-key") {
        showToast("No API key set — rank and match history need one. Everything else is up to date.");
      } else if (outcome.failed > 0) {
        showToast(`${outcome.succeeded} refreshed, ${outcome.failed} failed.`, true);
      }
      await reload();
    } catch (err) {
      showToast((err as Error).message, true);
    } finally {
      setRefreshing(false);
    }
  }, [reload, showToast]);

  // ---------------------------------------------------------------- switching

  const beginSwitch = useCallback(
    async (account: AccountView) => {
      if (account.isActive) {
        showToast(`${account.riotIdLabel} is already signed in.`);
        return;
      }
      setDetail(null);
      const preflight = await window.api.preflight(account.id);
      setSwitching({ account, preflight });
    },
    [showToast]
  );

  // ---------------------------------------------------------------- keyboard (P3.7)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = ["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName ?? "");

      if (e.key === "Escape" && !typing) {
        // Esc closes the switch dialog first, then the panel (PLAN §5).
        if (switching) return; // the modal owns Escape while it is up
        if (detail) setDetail(null);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      // Ctrl+1..9 switches directly.
      if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
        const index = Number(e.key) - 1;
        const target = visible[index];
        if (target) {
          e.preventDefault();
          void beginSwitch(target);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------------------------------------------------------------- derived

  const regions = useMemo(
    () => ["All", ...[...new Set(accounts.map((a) => a.region).filter((r): r is string => Boolean(r)))].sort()],
    [accounts]
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let list = accounts.filter((a) => {
      if (regionFilter !== "All" && a.region !== regionFilter) return false;
      if (!needle) return true;
      return (
        a.riotIdLabel.toLowerCase().includes(needle) ||
        a.loginUsername.toLowerCase().includes(needle) ||
        (a.label ?? "").toLowerCase().includes(needle)
      );
    });

    if (sort === "name") {
      list = [...list].sort((a, b) => a.riotIdLabel.localeCompare(b.riotIdLabel));
    } else if (sort === "recent") {
      list = [...list].sort((a, b) => (b.lastSwitchedAt ?? "").localeCompare(a.lastSwitchedAt ?? ""));
    }
    // "rank" keeps the order main already applied: active first, then by tier.
    return list;
  }, [accounts, query, regionFilter, sort]);

  const active = accounts.find((a) => a.isActive) ?? null;
  const signedInEnrolled = Boolean(
    status?.signedInAs && accounts.some((a) => a.riotIdLabel === status.signedInAs)
  );

  // ---------------------------------------------------------------- render

  return (
    <div className="app">
      <CrestSprite />

      <div className="titlebar">
        <div className="logo">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M1 3h6M1 3l2-2M1 3l2 2M11 9H5M11 9l-2-2M11 9l-2 2"
              fill="none"
              stroke="#8FB6D9"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <span className="name">LeagueSwitcher</span>
        <span style={{ marginLeft: "auto", fontSize: ".74rem", color: "var(--ink-3)" }}>
          {status?.gameRunning
            ? "In game — switching is disabled"
            : status?.riotClientRunning
              ? "Riot Client running"
              : "Riot Client closed"}
        </span>
      </div>

      <div className="toolbar">
        <div className="search">
          <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9.2 9.2 12.5 12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search accounts"
            aria-label="Search accounts"
            style={{
              background: "none",
              border: "none",
              outline: "none",
              color: "var(--ink)",
              font: "inherit",
              flex: 1,
              minWidth: 0,
            }}
          />
        </div>

        <div className="seg" role="group" aria-label="Sort by">
          {(["rank", "name", "recent"] as SortMode[]).map((mode) => (
            <button key={mode} aria-pressed={sort === mode} onClick={() => setSort(mode)}>
              {mode === "rank" ? "Rank" : mode === "name" ? "Name" : "Recent"}
            </button>
          ))}
        </div>

        {regions.length > 2 && (
          <div className="seg" role="group" aria-label="Filter region">
            {regions.map((region) => (
              <button key={region} aria-pressed={regionFilter === region} onClick={() => setRegionFilter(region)}>
                {region}
              </button>
            ))}
          </div>
        )}

        <span className="refresh">
          <i className="pulse" style={{ background: refreshing ? "var(--gold)" : "var(--emerald)" }} />
          {refreshing ? "Refreshing…" : status?.lastRefreshAt ? `Updated ${timeAgo(status.lastRefreshAt)}` : "Not refreshed yet"}
        </span>

        <button className="btn-add" onClick={() => void refreshNow()} disabled={refreshing}>
          Refresh
        </button>
        <button className="btn-add" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
        <button className="btn-add" onClick={() => setEnrolOpen(true)}>
          + Add account
        </button>
      </div>

      <div className="scroll">
        {status && !status.hasApiKey && accounts.length > 0 && (
          <div className="banner">
            <span>
              <b>No Riot API key.</b> Rank and match history need one — everything else on these cards comes from the
              Riot Client itself.
            </span>
            <button className="banner-act" onClick={() => setSettingsOpen(true)}>
              Add a key
            </button>
          </div>
        )}

        {status && !status.hasBaseline && accounts.length > 0 && (
          <div className="banner warn">
            <span>
              <b>No safety snapshot.</b> Take one so the original Riot session can always be put back.
            </span>
            <button
              className="banner-act"
              onClick={() => {
                void window.api.takeBaseline().then((r) => {
                  showToast(r.message, !r.ok);
                  void reload();
                });
              }}
            >
              Take snapshot
            </button>
          </div>
        )}

        {status?.gameRunning && (
          <div className="banner warn">
            <span>
              <b>A game is in progress.</b> Switching is disabled until it ends — it would disconnect you.
            </span>
          </div>
        )}

        {status?.warnings.map((warning) => (
          <div className="banner warn" key={warning}>
            <span>{warning}</span>
          </div>
        ))}

        {active && (
          <div className="active-wrap">
            <div className="active" style={{ ["--tier" as string]: `var(--${normaliseTier(active.tierKey)})` }}>
              <Crest tier={active.tierKey} className="" size={30} />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: ".5rem", marginBottom: ".15rem", flexWrap: "wrap" }}>
                  <span className="live-badge">SIGNED IN</span>
                  <span style={{ fontSize: ".74rem", color: "var(--ink-3)" }}>
                    {status?.riotClientRunning ? "Riot Client running" : "Riot Client closed"}
                  </span>
                </div>
                <div className="riotid" style={{ fontSize: "1.2rem" }}>
                  {active.gameName ? (
                    <>
                      {active.gameName}
                      <span className="tag">#{active.tagLine}</span>
                    </>
                  ) : (
                    active.loginUsername
                  )}
                </div>
                <div className="lp" style={{ marginTop: ".2rem" }}>
                  <span style={{ color: `var(--${normaliseTier(active.tierKey)})`, fontWeight: 700 }}>
                    {active.rankLabel}
                  </span>
                  {active.leaguePoints !== null && (
                    <>
                      {" · "}
                      <b>{active.leaguePoints}</b> LP
                    </>
                  )}
                  {active.wins + active.losses > 0 && ` · ${active.wins}W ${active.losses}L`}
                  {active.summonerLevel !== null && ` · Level ${active.summonerLevel}`}
                  {active.region && ` · ${active.region}`}
                </div>
              </div>
              <button className="btn-add" style={{ marginLeft: "auto" }} onClick={() => setDetail(active)}>
                Details
              </button>
            </div>
          </div>
        )}

        <div className="grid">
          {loading && accounts.length === 0 ? (
            <div className="empty">
              <h3>Loading…</h3>
            </div>
          ) : accounts.length === 0 ? (
            // P5.3 — with nothing enrolled, the empty grid IS the first-run wizard. A separate
            // "welcome" screen would just be a click in front of the same two actions.
            <FirstRun status={status} onDone={() => void reload()} onToast={showToast} />
          ) : visible.length === 0 ? (
            <div className="empty">
              <h3>Nothing matches</h3>
              <p>No account matches that search or region filter.</p>
            </div>
          ) : (
            <>
              {visible.map((account) => (
                <AccountCard
                  key={account.id}
                  account={account}
                  loading={refreshing || (loading && account.lastUpdated === null)}
                  onSwitch={(a) => void beginSwitch(a)}
                  onDetails={setDetail}
                  onRetry={(a) => {
                    void window.api.refresh(a.id).then(reload);
                  }}
                />
              ))}
              <button className="addcard" onClick={() => setEnrolOpen(true)}>
                <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
                  <path d="M11 5v12M5 11h12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                </svg>
                Add account
              </button>
            </>
          )}
        </div>
      </div>

      <DetailPanel
        account={detail}
        onClose={() => setDetail(null)}
        onSwitch={(a) => void beginSwitch(a)}
        onReenrol={(a) => {
          setDetail(null);
          setEnrolOpen(true);
          showToast(`Re-enrol ${a.loginUsername} with "Sign in to add".`);
        }}
        onDelete={(a) => {
          void (async () => {
            await window.api.removeAccount(a.id);
            setDetail(null);
            await reload();
            showToast(`Removed ${a.riotIdLabel}.`);
          })();
        }}
        onToast={showToast}
      />

      {switching && (
        <SwitchModal
          account={switching.account}
          preflight={switching.preflight}
          onCancel={() => setSwitching(null)}
          onDone={(result) => {
            setSwitching(null);
            showToast(`Switched in ${(result.elapsedMs / 1000).toFixed(1)}s.`);
            void reload();
          }}
        />
      )}

      {enrolOpen && (
        <EnrolModal
          status={status}
          signedInAlreadyEnrolled={signedInEnrolled}
          onClose={() => setEnrolOpen(false)}
          onEnrolled={() => {
            setEnrolOpen(false);
            void reload();
          }}
          onToast={showToast}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          status={status}
          onClose={() => setSettingsOpen(false)}
          onToast={showToast}
          onChanged={() => void refreshNow()}
        />
      )}

      {toast && <div className={`toast${toast.error ? " error" : ""}`}>{toast.message}</div>}
    </div>
  );
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
