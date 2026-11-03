"use client";

import { createContext, startTransition, useContext, useEffect, useRef, useState } from "react";
import type { Row } from "@/lib/bounty.ts";
import { usd } from "./labels.ts";

type Act = Row["actions"][number];
type Where = "grid" | "panel";
export type Notice = { tone: "ok" | "error"; text: string };
/** What a dashboard server action reports. Expected failures come back as a message, because production Next hides thrown ones. */
export type Outcome = { ok: true } | { ok: false; message: string };

const UNEXPECTED = "Something went wrong on the server. Its log has the details.";

/** Runs a server action and turns an unexpected throw into the same shape as an expected failure. */
export async function attempt(action: () => Promise<Outcome>): Promise<Outcome> {
  try {
    return await action();
  } catch (e) {
    console.error(e);
    return { ok: false, message: UNEXPECTED };
  }
}

type Review = {
  canAct: boolean;
  confirming: { id: string; where: Where } | null;
  running: Readonly<Record<string, Act>>;
  ask(row: Row, act: Act, where: Where): void;
  confirm(row: Row): void;
  cancel(): void;
};

const ReviewContext = createContext<Review | null>(null);
export const ReviewProvider = ReviewContext.Provider;

const useReviewContext = () => {
  const review = useContext(ReviewContext);
  if (!review) throw new Error("ReviewButtons needs a ReviewProvider");
  return review;
};

/** Approve asks first and names the money; Reject runs at once. Both report through `notify`, never alert(). */
export function useReview(
  canAct: boolean,
  run: Record<Act, (id: string) => Promise<Outcome>>,
  notify: (n: Notice) => void,
): Review {
  const [confirming, setConfirming] = useState<Review["confirming"]>(null);
  const [running, setRunning] = useState<Record<string, Act>>({});

  const go = (row: Row, act: Act) => {
    setConfirming(null);
    setRunning((r) => ({ ...r, [row.id]: act }));
    startTransition(async () => {
      const outcome = await attempt(() => run[act](row.id));
      setRunning(({ [row.id]: _, ...rest }) => rest);
      notify(
        outcome.ok
          ? { tone: "ok", text: act === "approve" ? `Approved ${usd(row.amount)} to ${row.payee} for ${row.id}.` : `Rejected ${row.id}.` }
          : { tone: "error", text: `Couldn't ${act} ${row.id}: ${outcome.message}` },
      );
    });
  };

  return {
    canAct,
    confirming,
    running,
    ask: (row, act, where) => (act === "approve" ? setConfirming({ id: row.id, where }) : go(row, act)),
    confirm: (row) => go(row, "approve"),
    cancel: () => setConfirming(null),
  };
}

export function ReviewButtons({ row, where }: { row: Row; where: Where }) {
  const { canAct, confirming, running, ask, confirm, cancel } = useReviewContext();
  const payRef = useRef<HTMLButtonElement>(null);
  const asking = confirming?.id === row.id && confirming.where === where;

  useEffect(() => {
    if (asking) payRef.current?.focus();
  }, [asking]);

  if (!canAct || row.actions.length === 0) return null;
  const busy = running[row.id];
  if (busy) {
    return (
      <span className="review" data-where={where}>
        <button className="primary" disabled aria-busy="true">
          <span className="spinner" aria-hidden="true" />
          {busy === "approve" ? "Paying…" : "Rejecting…"}
        </button>
      </span>
    );
  }
  if (asking) {
    const question = `Pay ${usd(row.amount)} to ${row.payee}?`;
    return (
      <span
        className="review review-confirm"
        data-where={where}
        role="group"
        aria-label={question}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          cancel();
        }}
      >
        <span className="review-question" title={question}>
          Pay <strong>{usd(row.amount)}</strong> to {row.payee}?
        </span>
        <span className="review-buttons">
          <button ref={payRef} className="primary" onClick={() => confirm(row)}>
            Pay
          </button>
          <button onClick={cancel}>Cancel</button>
        </span>
      </span>
    );
  }
  return (
    <span className="review" data-where={where}>
      {row.actions.includes("approve") && (
        <button className="primary" aria-label={`Approve ${row.id}`} onClick={() => ask(row, "approve", where)}>
          Approve
        </button>
      )}
      {row.actions.includes("reject") && (
        <button aria-label={`Reject ${row.id}`} onClick={() => ask(row, "reject", where)}>
          Reject
        </button>
      )}
    </span>
  );
}
