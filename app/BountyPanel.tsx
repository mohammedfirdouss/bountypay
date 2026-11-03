"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Policy, Row } from "@/lib/bounty.ts";
import { APPROVERS, approverOf, holdReason, holdReasons, PAYPAL, percent, STATES, usd, verdictOf } from "./labels.ts";
import { ReviewButtons } from "./Review.tsx";

type Props = {
  row: Row;
  policy: Policy;
  position: { index: number; count: number } | null;
  canAct: boolean;
  modal: boolean;
  onStep(delta: 1 | -1): void;
  onClose(): void;
};

export function BountyPanel({ row, policy, position, canAct, modal, onStep, onClose }: Props) {
  const ref = useRef<HTMLElement>(null);
  const verdict = verdictOf(row);
  const approver = approverOf(row);
  const reasons = holdReasons(row);

  useEffect(() => {
    ref.current?.focus();
  }, [row.id]);

  const keys = useRef({ onStep, onClose });
  keys.current = { onStep, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      const ours = t === document.body || (t instanceof Node && ref.current?.contains(t));
      if (!ours || e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        keys.current.onClose();
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        keys.current.onStep(e.key === "ArrowDown" ? 1 : -1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    if (!modal) {
      main.classList.add("beside-panel");
      return () => main.classList.remove("beside-panel");
    }
    main.inert = true;
    return () => {
      main.inert = false;
    };
  }, [modal]);

  return createPortal(
    <aside
      ref={ref}
      className="panel"
      role="dialog"
      aria-modal={modal}
      aria-labelledby="panel-title"
      tabIndex={-1}
    >
      <header className="panel-head">
        <div className="panel-title">
          <span className={`badge badge-${row.state}`} title={STATES[row.state].hint}>
            {STATES[row.state].label}
          </span>
          <h2 id="panel-title">{row.id}</h2>
          <p className="panel-money">
            <strong>{usd(row.amount)}</strong> to {row.payee}
          </p>
        </div>
        <div className="panel-nav">
          <button aria-label="Previous bounty" title="Previous bounty (↑)" disabled={!position || position.index === 0} onClick={() => onStep(-1)}>
            <Chevron up />
          </button>
          <button
            aria-label="Next bounty"
            title="Next bounty (↓)"
            disabled={!position || position.index === position.count - 1}
            onClick={() => onStep(1)}
          >
            <Chevron />
          </button>
          <button className="panel-close" aria-label="Close details" title="Close (Esc)" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <div className="panel-body">
        <p className="panel-hint">{STATES[row.state].hint}.</p>

        <section aria-labelledby="verdict-h">
          <h3 id="verdict-h">Claude&apos;s verdict</h3>
          {verdict ? (
            <>
              <div className="verdict-line">
                <span className={`badge badge-verdict-${verdict.decision}`}>{verdict.decision === "pay" ? "Pay" : "Hold"}</span>
                <span>
                  {percent(verdict.confidence)} sure the PR resolves issue #{row.issue}
                </span>
              </div>
              <Meter value={verdict.confidence} threshold={policy.minConfidence} large />
              <p className="reasoning-full">{verdict.reasoning}</p>
            </>
          ) : (
            <p className="muted">
              {row.state === "judging" ? "Claude is reading the diff. The verdict appears here in a few seconds." : "Claude gave no verdict for this PR."}
            </p>
          )}
        </section>

        {reasons.length > 0 && (
          <section aria-labelledby="held-h">
            <h3 id="held-h">Held because</h3>
            <ul className="reasons">
              {reasons.map((r) => (
                <li key={r}>{holdReason(r, row, policy).long}</li>
              ))}
            </ul>
          </section>
        )}

        {approver && (
          <section aria-labelledby="approved-h">
            <h3 id="approved-h">Approved by</h3>
            <p className="approved">
              <span className={`badge badge-by-${approver}`}>{APPROVERS[approver].label}</span>
              {approver === "maintainer" && verdict && verdict.confidence < policy.minConfidence
                ? `A maintainer approved it from this dashboard. Claude alone would not have paid at ${percent(verdict.confidence)}.`
                : `${APPROVERS[approver].hint}.`}
            </p>
          </section>
        )}

        {(row.state === "sent" || row.state === "failed") && (
          <section aria-labelledby="paypal-h">
            <h3 id="paypal-h">PayPal</h3>
            {row.state === "sent" ? (
              <dl className="facts">
                <dt>Batch</dt>
                <dd>
                  <code>{row.payoutBatchId}</code>
                </dd>
                <dt>Status</dt>
                <dd>
                  <span className={`badge badge-pp-${row.payoutStatus}`}>{row.payoutStatus}</span> {PAYPAL[row.payoutStatus]}.
                </dd>
              </dl>
            ) : (
              <p className="error-text">{row.error}</p>
            )}
          </section>
        )}

        <section aria-labelledby="links-h">
          <h3 id="links-h">On GitHub</h3>
          <p className="links">
            <a href={`https://github.com/${row.repo}/issues/${row.issue}`} target="_blank" rel="noreferrer">
              Issue #{row.issue}
            </a>
            <a href={row.prUrl} target="_blank" rel="noreferrer">
              Pull request #{row.pr}
            </a>
          </p>
        </section>
      </div>

      {row.actions.length > 0 && (
        <footer className="panel-foot">
          {canAct ? <ReviewButtons row={row} where="panel" /> : <p className="muted">Enter the dashboard token above to approve or reject.</p>}
        </footer>
      )}
      {position && (
        <p className="panel-keys" aria-hidden="true">
          {position.index + 1} of {position.count} · <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Esc</kbd> to close
        </p>
      )}
    </aside>,
    document.body,
  );
}

export function Meter({ value, threshold, large }: { value: number; threshold: number; large?: boolean }) {
  const pass = value >= threshold;
  return (
    <span
      className={`meter ${pass ? "meter-pass" : "meter-below"}${large ? " meter-large" : ""}`}
      role="img"
      aria-label={`${percent(value)} confidence, ${pass ? "at or above" : "below"} the ${percent(threshold)} auto-pay threshold`}
    >
      <span className="meter-fill" style={{ width: `${value * 100}%` }} />
      <span className="meter-tick" style={{ left: `${threshold * 100}%` }} />
      {large && (
        <span className="meter-tick-label" style={{ left: `${threshold * 100}%` }}>
          {percent(threshold)} to auto-pay
        </span>
      )}
    </span>
  );
}

function Chevron({ up }: { up?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d={up ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
