/**
 * P3.3 — switch confirmation, then live progress in the same modal.
 *
 * PLAN §5: "a modal with real step feedback rather than an opaque spinner, because a 15-second
 * operation with no feedback feels broken." The switch turned out to take ~7s, which if
 * anything makes feedback more important, not less: a progress list that is visibly moving is
 * the difference between "working" and "frozen".
 *
 * The steps shown are the actual `SwitchStep` values the engine emits, so the list cannot drift
 * out of step with what the engine really does.
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { AccountView, Preflight, SwitchProgress, SwitchResult } from "../../shared/ipc.js";
import { normaliseTier } from "../crests.js";

type Phase = "confirm" | "running" | "failed";

interface Props {
  account: AccountView;
  preflight: Preflight | null;
  onCancel: () => void;
  onDone: (result: SwitchResult) => void;
}

/** The user-facing step list, mapped from the engine's own step names. */
const STEPS: Array<{ key: string; label: string }> = [
  { key: "preflight", label: "Check it is safe to switch" },
  { key: "capturing-current", label: "Save the current session" },
  { key: "stopping-client", label: "Close League and Riot Client" },
  { key: "restoring-session", label: "Restore this account's session" },
  { key: "launching-client", label: "Relaunch Riot Client" },
  { key: "waiting-for-login", label: "Wait for automatic sign-in" },
  { key: "recapturing", label: "Save the refreshed session" },
  { key: "updating-profile", label: "Update account details" },
];

export function SwitchModal({ account, preflight, onCancel, onDone }: Props): JSX.Element {
  const [phase, setPhase] = useState<Phase>("confirm");
  const [progress, setProgress] = useState<SwitchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = window.api.onSwitchProgress((event) => {
      if (event.accountId === account.id) setProgress(event);
    });
    return unsubscribe;
  }, [account.id]);

  useEffect(() => {
    if (phase === "running") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, onCancel]);

  const blocked = preflight ? !preflight.canSwitch : false;
  const needsConfirm = (preflight?.confirmations.length ?? 0) > 0;

  async function start(): Promise<void> {
    setPhase("running");
    setError(null);
    try {
      const result = await window.api.startSwitch(account.id, { confirmed: true });
      if (result.ok) {
        onDone(result);
      } else {
        setError(result.error ?? "The switch failed.");
        setPhase("failed");
      }
    } catch (err) {
      setError((err as Error).message);
      setPhase("failed");
    }
  }

  const currentIndex = progress ? STEPS.findIndex((s) => s.key === progress.step) : -1;
  const percent = progress?.step === "done" ? 100 : Math.max(0, ((currentIndex + 1) / STEPS.length) * 100);

  return (
    <div className="scrim" data-open="true" role="dialog" aria-modal="true" aria-labelledby="mtitle">
      <div className="modal" style={{ ["--tier" as string]: `var(--${normaliseTier(account.tierKey)})` }}>
        <h3 id="mtitle">
          {phase === "running" ? "Switching to " : phase === "failed" ? "Could not switch to " : "Switch to "}
          <span>{account.riotIdLabel}</span>
          {phase === "confirm" ? "?" : ""}
        </h3>

        {phase === "failed" && error && <div className="err">{error}</div>}

        {phase === "confirm" && (
          <>
            {preflight?.blockers.map((b) => (
              <div className="err" key={b.code}>
                {b.message}
              </div>
            ))}
            {preflight?.confirmations.map((c) => (
              <div className="warnbox" key={c.code}>
                <strong>{c.message}</strong>
              </div>
            ))}
            {preflight?.notes.map((n) => (
              <p key={n} style={{ fontSize: ".82rem", color: "var(--ink-3)" }}>
                {n}
              </p>
            ))}
            <p style={{ fontSize: ".82rem", color: "var(--ink-3)", marginBottom: ".5rem" }}>What happens next:</p>
          </>
        )}

        {phase === "running" && (
          <div className="progressline">
            <span style={{ width: `${percent}%` }} />
          </div>
        )}

        <ul className="steps">
          {STEPS.map((step, index) => {
            const state =
              phase !== "running" && phase !== "failed"
                ? ""
                : currentIndex > index || progress?.step === "done"
                  ? "done"
                  : currentIndex === index
                    ? "doing"
                    : "";
            return (
              <li key={step.key} className={state}>
                <span className="n">{String(index + 1).padStart(2, "0")}</span>
                <span>
                  {state === "doing" && progress ? progress.message : step.label}
                  {state === "doing" && progress?.detail ? (
                    <span style={{ color: "var(--ink-3)" }}> — {progress.detail}</span>
                  ) : null}
                </span>
              </li>
            );
          })}
          <li>
            <span className="n">—</span>
            <span>
              League is <em>not</em> launched — start it yourself
            </span>
          </li>
        </ul>

        <div className="mbtns">
          <button className="mbtn" onClick={onCancel} disabled={phase === "running"}>
            {phase === "failed" ? "Close" : "Cancel"}
          </button>
          {phase !== "failed" && (
            <button className="mbtn go" onClick={() => void start()} disabled={blocked || phase === "running"}>
              {phase === "running" ? "Switching…" : needsConfirm ? "Close it and switch" : "Switch account"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
