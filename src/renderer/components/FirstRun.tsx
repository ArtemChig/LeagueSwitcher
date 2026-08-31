/**
 * P5.3 — the first-run wizard.
 *
 * Two steps, in this order and not the other, because the order is the safety property:
 *
 *   1. Take a safety snapshot of the session file that is on this machine right now. This app
 *      rewrites the file the Riot Client authenticates from, so "put back exactly what was
 *      there before we touched anything" has to be possible — and it only is if it was copied
 *      first. PLAN §7 rule 1: backup before anything else, no exceptions.
 *   2. Capture the signed-in account, which is the one-click enrolment.
 *
 * Step 2 stays disabled until step 1 has been done, so the wizard cannot be completed in the
 * unsafe order. Both steps are idempotent — re-running either is harmless.
 */
import type { JSX } from "react";
import { useState } from "react";
import type { AppStatus } from "../../shared/ipc.js";

interface Props {
  status: AppStatus | null;
  onDone: () => void;
  onToast: (message: string, isError?: boolean) => void;
}

export function FirstRun({ status, onDone, onToast }: Props): JSX.Element {
  const [backedUp, setBackedUp] = useState(Boolean(status?.hasBaseline));
  const [busy, setBusy] = useState<"backup" | "capture" | null>(null);

  async function takeBackup(): Promise<void> {
    setBusy("backup");
    try {
      const result = await window.api.takeBaseline();
      onToast(result.message, !result.ok);
      if (result.ok) setBackedUp(true);
    } catch (err) {
      onToast((err as Error).message, true);
    } finally {
      setBusy(null);
    }
  }

  async function capture(): Promise<void> {
    setBusy("capture");
    try {
      const result = await window.api.capture();
      if (result.ok) {
        onToast("Account captured — you can switch back to it any time.");
        onDone();
      } else {
        onToast(result.error ?? "Capture failed.", true);
      }
    } catch (err) {
      onToast((err as Error).message, true);
    } finally {
      setBusy(null);
    }
  }

  const signedIn = Boolean(status?.signedInAs);

  return (
    <div className="empty" style={{ textAlign: "left", padding: "2rem 2.2rem", maxWidth: "44rem", margin: "0 auto" }}>
      <h3 style={{ textAlign: "center", marginTop: 0 }}>Set up LeagueSwitcher</h3>
      <p style={{ textAlign: "center", marginBottom: "1.6rem" }}>
        Two steps, once. After this, switching accounts is one click — no password, no captcha.
      </p>

      <ol className="steps" style={{ counterReset: "none" }}>
        <li style={{ alignItems: "flex-start", padding: ".7rem 0", borderTop: "1px solid var(--rule)" }}>
          <span className="n" style={{ color: backedUp ? "var(--emerald)" : "var(--steel)" }}>
            {backedUp ? "✓" : "01"}
          </span>
          <span style={{ flex: 1 }}>
            <b style={{ color: "var(--ink)", display: "block", fontFamily: "Rajdhani, sans-serif", fontSize: ".98rem" }}>
              Take a safety snapshot
            </b>
            <span style={{ color: "var(--ink-3)", fontSize: ".84rem", lineHeight: 1.5 }}>
              Copies the Riot session file as it is right now, so the original can always be put back. Nothing is
              changed — it only reads.
            </span>
            <span style={{ display: "block", marginTop: ".55rem" }}>
              <button className="btn-add" onClick={() => void takeBackup()} disabled={busy !== null}>
                {busy === "backup" ? "Saving…" : backedUp ? "Take another snapshot" : "Take snapshot"}
              </button>
            </span>
          </span>
        </li>

        <li style={{ alignItems: "flex-start", padding: ".7rem 0", borderTop: "1px solid var(--rule)" }}>
          <span className="n" style={{ color: backedUp ? "var(--steel)" : "var(--ink-3)" }}>
            02
          </span>
          <span style={{ flex: 1 }}>
            <b style={{ color: "var(--ink)", display: "block", fontFamily: "Rajdhani, sans-serif", fontSize: ".98rem" }}>
              Add the account you are signed in as
            </b>
            <span style={{ color: "var(--ink-3)", fontSize: ".84rem", lineHeight: 1.5 }}>
              {signedIn ? (
                <>
                  The Riot Client is signed in as <b style={{ color: "var(--ink-2)" }}>{status?.signedInAs}</b>. Storing
                  that session is all it takes — nothing is closed and no password is needed.
                </>
              ) : (
                <>Sign in to the Riot Client first, then come back — this step stores that session.</>
              )}
            </span>
            <span style={{ display: "block", marginTop: ".55rem" }}>
              <button
                className="btn-add"
                onClick={() => void capture()}
                disabled={busy !== null || !backedUp || !signedIn}
                title={!backedUp ? "Take the safety snapshot first" : !signedIn ? "Nothing is signed in" : undefined}
                style={!backedUp || !signedIn ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
              >
                {busy === "capture" ? "Capturing…" : "Capture this account"}
              </button>
            </span>
          </span>
        </li>
      </ol>

      <p className="hint" style={{ marginTop: "1.2rem", borderTop: "1px solid var(--rule)", paddingTop: "1rem" }}>
        To add accounts you are <i>not</i> currently signed in as, use <b>+ Add account</b> and pick{" "}
        <b>Sign in to add</b> — you sign in once, including the captcha, and the session is captured automatically.
      </p>
    </div>
  );
}
