/**
 * P3.4 — adding an account.
 *
 * Two routes, and the choice between them is the point:
 *
 *   Capture — the Riot Client is already signed in as the account you want to add. One click,
 *     nothing is closed, nothing is typed. This is the path almost everyone should take, so it
 *     is offered first and pre-selected whenever a signed-in account is not yet enrolled.
 *
 *   Assisted — the S4 ladder rung that cannot break. The client is signed out, the username is
 *     prefilled, and the user completes the sign-in including the captcha. The moment the
 *     client reports a session it is captured.
 *
 * There is deliberately no "type your password and we'll log you in" route here. Riot issues an
 * hCaptcha challenge on every login (RESEARCH §3), and solving captchas is out of scope by
 * decision. Offering a password box that usually fails would be worse than not offering one.
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { AppStatus, SwitchProgress } from "../../shared/ipc.js";

type Mode = "capture" | "assisted";

interface Props {
  status: AppStatus | null;
  /** True when the signed-in account already has a profile — capture would just refresh it. */
  signedInAlreadyEnrolled: boolean;
  onClose: () => void;
  onEnrolled: (accountId: string) => void;
  onToast: (message: string, isError?: boolean) => void;
}

export function EnrolModal({ status, signedInAlreadyEnrolled, onClose, onEnrolled, onToast }: Props): JSX.Element {
  const canCapture = Boolean(status?.signedInAs) && !signedInAlreadyEnrolled;
  const [mode, setMode] = useState<Mode>(canCapture ? "capture" : "assisted");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SwitchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => window.api.onSwitchProgress((e) => setProgress(e)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === "capture" ? await window.api.capture() : await window.api.assistedEnrol(username.trim());

      if (result.ok && result.accountId) {
        onEnrolled(result.accountId);
        onToast(mode === "capture" ? "Account captured." : "Account enrolled.");
      } else {
        setError(result.error ?? "Enrolment failed.");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scrim" data-open="true" role="dialog" aria-modal="true" aria-labelledby="etitle">
      <div className="modal">
        <h3 id="etitle">Add an account</h3>

        {error && <div className="err">{error}</div>}

        <div className="seg" role="group" aria-label="How to add" style={{ marginBottom: "1rem" }}>
          <button aria-pressed={mode === "capture"} onClick={() => setMode("capture")} disabled={busy}>
            Capture signed-in
          </button>
          <button aria-pressed={mode === "assisted"} onClick={() => setMode("assisted")} disabled={busy}>
            Sign in to add
          </button>
        </div>

        {mode === "capture" ? (
          <>
            {status?.signedInAs ? (
              signedInAlreadyEnrolled ? (
                <div className="warnbox">
                  <strong>{status.signedInAs}</strong> is already enrolled. Capturing again just refreshes its stored
                  session, which is harmless.
                </div>
              ) : (
                <p>
                  The Riot Client is signed in as <b>{status.signedInAs}</b>. Capturing stores that session so you can
                  switch back to it any time — nothing is closed and no password is needed.
                </p>
              )
            ) : (
              <div className="warnbox">
                <strong>Nothing is signed in.</strong> Sign in to the Riot Client first, or use <b>Sign in to add</b>.
              </div>
            )}
          </>
        ) : (
          <>
            <p>
              The Riot Client will open at a clean sign-in screen with this username filled in. Sign in there — including
              the captcha — and the session is captured automatically.
            </p>
            <div className="field">
              <label htmlFor="e-user">Login username</label>
              <div className="inwrap">
                <input
                  id="e-user"
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="the username you type at Riot's sign-in"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={busy}
                />
              </div>
            </div>
            <div className="warnbox">
              Your current session is saved first, so this cannot cost you the account you are signed in as.
            </div>
          </>
        )}

        {busy && progress && (
          <p className="hint" style={{ marginTop: ".8rem" }}>
            {progress.message}
            {progress.detail ? ` — ${progress.detail}` : ""}
          </p>
        )}

        <div className="mbtns" style={{ marginTop: "1.1rem" }}>
          <button className="mbtn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="mbtn go"
            onClick={() => void run()}
            disabled={busy || (mode === "capture" ? !status?.signedInAs : username.trim().length === 0)}
          >
            {busy ? "Working…" : mode === "capture" ? "Capture this account" : "Open sign-in"}
          </button>
        </div>
      </div>
    </div>
  );
}
