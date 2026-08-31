/**
 * P3.6 — settings, including the panic restore.
 *
 * Panic restore puts the baseline snapshot back over the live session file. It exists because
 * this app rewrites the file the Riot Client authenticates from, and the honest answer to "what
 * if it goes wrong at 2am" should be a button rather than a paragraph of PowerShell.
 *
 * It is deliberately behind a typed confirmation. It closes the Riot Client and discards
 * whatever session is currently in place, which is the right thing when something has gone
 * wrong and precisely the wrong thing to trigger by a stray click.
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { AppStatus } from "../../shared/ipc.js";

interface Props {
  status: AppStatus | null;
  onClose: () => void;
  onToast: (message: string, isError?: boolean) => void;
  onChanged: () => void;
}

export function SettingsModal({ status, onClose, onToast, onChanged }: Props): JSX.Element {
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(Boolean(status?.hasApiKey));
  const [confirmText, setConfirmText] = useState("");
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    void window.api.getApiKeyState().then((s) => setHasKey(s.present));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function saveKey(): Promise<void> {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    await window.api.setApiKey(trimmed);
    setApiKey("");
    setHasKey(true);
    onToast("API key saved, encrypted. Refreshing…");
    onChanged();
  }

  async function clearKey(): Promise<void> {
    await window.api.setApiKey(null);
    setHasKey(false);
    onToast("API key removed.");
    onChanged();
  }

  async function panicRestore(): Promise<void> {
    setRestoring(true);
    try {
      const result = await window.api.panicRestore();
      onToast(result.message, !result.ok);
      if (result.ok) onChanged();
    } finally {
      setRestoring(false);
      setConfirmText("");
    }
  }

  return (
    <div className="scrim" data-open="true" role="dialog" aria-modal="true" aria-labelledby="stitle">
      <div className="modal" style={{ width: "min(520px,100%)" }}>
        <h3 id="stitle">Settings</h3>

        <p className="plabel" style={{ marginTop: "1rem" }}>
          Riot API key
        </p>
        <p style={{ fontSize: ".84rem", color: "var(--ink-2)", marginTop: 0 }}>
          Optional. Without one, cards still show Riot ID, username, region, level and profile icon — all of which come
          from the Riot Client itself. A key adds <b>rank</b> and match history.
        </p>
        <div className="field">
          <div className="inwrap">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={hasKey ? "A key is stored — paste a new one to replace it" : "RGAPI-…"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button className="reveal" onClick={() => void saveKey()} disabled={!apiKey.trim()}>
              Save
            </button>
          </div>
        </div>
        {hasKey && (
          <button className="pbtn" style={{ marginBottom: ".4rem" }} onClick={() => void clearKey()}>
            Remove stored key
          </button>
        )}

        <p className="plabel" style={{ marginTop: "1.4rem" }}>
          Data
        </p>
        <div className="setrow">
          <div>
            <div className="k">App data folder</div>
            <div className="d">Sessions, vault, logs and cached assets. Nothing sensitive is ever in the app folder.</div>
          </div>
          <button className="pbtn" onClick={() => void window.api.openDataFolder()}>
            Open
          </button>
        </div>
        <div className="setrow">
          <div>
            <div className="k">Data Dragon</div>
            <div className="d">Asset version currently pinned.</div>
          </div>
          <span className="region">{status?.dataDragonVersion ?? "—"}</span>
        </div>

        <p className="plabel" style={{ marginTop: "1.4rem", color: "#E08582" }}>
          Panic restore
        </p>
        <div className="warnbox" style={{ background: "rgba(224,133,130,.08)", borderColor: "rgba(224,133,130,.3)", color: "#E08582" }}>
          Puts the <b>original</b> session back — the one captured before this app touched anything. Closes the Riot
          Client and discards whatever is signed in now. Use it if a switch has left the client in a bad state.
        </div>
        <div className="field">
          <label htmlFor="s-confirm">Type RESTORE to enable</label>
          <div className="inwrap">
            <input
              id="s-confirm"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
            />
            <button
              className="reveal"
              style={{ color: confirmText === "RESTORE" ? "#E08582" : undefined }}
              disabled={confirmText !== "RESTORE" || restoring}
              onClick={() => void panicRestore()}
            >
              {restoring ? "…" : "Restore"}
            </button>
          </div>
        </div>

        {status && status.warnings.length > 0 && (
          <>
            <p className="plabel" style={{ marginTop: "1.4rem" }}>
              Warnings
            </p>
            {status.warnings.map((w) => (
              <p key={w} className="hint" style={{ marginTop: 0 }}>
                {w}
              </p>
            ))}
          </>
        )}

        <div className="mbtns" style={{ marginTop: "1.2rem" }}>
          <button className="mbtn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
