import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { comment, fetchBountyIssue, fetchDiff, type MergedPr } from "./github.ts";
import { judge, Verdict } from "./judge.ts";
import { sendPayout, type PayoutStatus } from "./paypal.ts";

export type BountyId = string & { readonly __brand: "BountyId" };
/** Integer USD cents, never floats. */
export type Cents = number & { readonly __brand: "Cents" };
export type Email = string & { readonly __brand: "Email" };
export type { PayoutStatus };

/** Facts fixed when a merged PR claims the bounty. Never rewritten for the life of the claim. */
export type Claim = {
  id: BountyId;
  repo: string;
  issue: number;
  pr: number;
  prUrl: string;
  amount: Cents;
  payee: Email;
};

type Approver = "claude" | "maintainer";

export type HoldReason = "judged_unresolved" | "low_confidence" | "over_cap" | "refused" | "judge_failed";

/**
 * The lifecycle. Each state carries exactly the fields that exist in it.
 * BountyPay's decision ends at `sent`; PayPal's later word on the money is `payoutStatus`, written only by its webhook.
 */
export type Bounty = Claim & { updatedAt: string } & (
    | { state: "judging" }
    | { state: "held"; verdict: Verdict | null; reason: HoldReason }
    | { state: "paying"; verdict: Verdict | null; approvedBy: Approver }
    | { state: "sent"; verdict: Verdict | null; approvedBy: Approver; payoutBatchId: string; payoutStatus: PayoutStatus }
    | { state: "failed"; verdict: Verdict | null; approvedBy: Approver; error: string }
    | { state: "rejected"; verdict: Verdict | null }
  );
export type State = Bounty["state"];

/**
 * Every legal transition, keyed by the event that causes it and the actor allowed to cause it.
 * move() derives its SQL guard from `from`, and listBounties() derives each row's dashboard buttons from it.
 * Claiming (no row, or `rejected` by another PR, -> `judging`) lives in insertClaim because it is an upsert.
 */
const MOVES = {
  verdictPay: { by: "claude", from: ["judging"], to: "paying" },
  verdictHold: { by: "claude", from: ["judging"], to: "held" },
  approve: { by: "maintainer", from: ["judging", "held", "failed"], to: "paying" },
  reject: { by: "maintainer", from: ["judging", "held", "failed"], to: "rejected" },
  payoutSent: { by: "paypal", from: ["paying"], to: "sent" },
  payoutError: { by: "paypal", from: ["paying"], to: "failed" },
} as const satisfies Record<string, { by: string; from: readonly State[]; to: State }>;
type Move = keyof typeof MOVES;
type MaintainerMove = { [M in Move]: (typeof MOVES)[M]["by"] extends "maintainer" ? M : never }[Move];

/** Fields the target state adds. Fields not given keep their stored value. */
type Patch<S extends State> = Omit<Extract<Bounty, { state: S }>, keyof Claim | "state" | "updatedAt">;

export type Row = Bounty & { actions: MaintainerMove[] };

export type Policy = { minConfidence: number; cap: Cents };
export type Decision = { next: "pay" } | { next: "hold"; reason: HoldReason };

/** The mandate Claude acts under. Constants, so the rule in the repo is the rule that runs. */
export const POLICY: Policy = { minConfidence: 0.8, cap: 100_00 as Cents };

/** The money decision. Pure. Claude can only narrow it: a null verdict (refusal) or any doubt holds. */
export function decide(claim: Claim, verdict: Verdict | null, policy: Policy = POLICY): Decision {
  if (!verdict) return { next: "hold", reason: "refused" };
  if (verdict.decision === "hold") return { next: "hold", reason: "judged_unresolved" };
  if (verdict.confidence < policy.minConfidence) return { next: "hold", reason: "low_confidence" };
  if (claim.amount > policy.cap) return { next: "hold", reason: "over_cap" };
  return { next: "pay" };
}

export function bountyId(repo: string, issue: number): BountyId {
  return `${repo}#${issue}` as BountyId;
}

const usd = (c: Cents) => `$${(c / 100).toFixed(2)}`;

/** Webhook path. Safe to call any number of times, concurrently, for the same PR. */
export async function ingest(merge: MergedPr): Promise<void> {
  const issue = await fetchBountyIssue(merge.repo, merge.issue);
  if (!issue) return;
  if (!merge.payee) {
    await comment(merge.repo, merge.pr, "BountyPay: this PR closes a bounty issue but has no `PayPal: you@example.com` line, so no payout was started. Add the line and ask a maintainer to redeliver the merge webhook.");
    return;
  }
  const id = bountyId(merge.repo, merge.issue);
  const stored = insertClaim({ ...merge, id, amount: issue.amount, payee: merge.payee });
  if (stored.pr !== merge.pr) {
    await comment(merge.repo, merge.pr, `BountyPay: the bounty on #${merge.issue} is already claimed by #${stored.pr}.`);
    return;
  }

  if (stored.state === "judging") {
    let verdict: Verdict | null;
    try {
      verdict = await judge({ issue, pr: merge, diff: await fetchDiff(merge.repo, merge.pr) });
    } catch (e) {
      console.error(`judge failed for ${id}:`, e);
      const held = move(id, "verdictHold", { verdict: null, reason: "judge_failed" });
      if (held) await comment(held.repo, held.pr, heldNotice(held));
      return;
    }
    const d = decide(stored, verdict);
    if (d.next === "hold") {
      const held = move(id, "verdictHold", { verdict, reason: d.reason });
      if (held) await comment(held.repo, held.pr, heldNotice(held));
      return;
    }
    move(id, "verdictPay", { verdict, approvedBy: "claude" });
  }
  // Also resumes a `paying` row left by a crash or a lost PayPal response.
  await pay(id);
}

/** Maintainer path. Pays a held, failed, or stuck-judging bounty through the same pay() as the webhook. */
export async function approve(id: string): Promise<Bounty> {
  const b = load(id);
  if (!b) throw new Error(`unknown bounty ${id}`);
  if (!move(b.id, "approve", { approvedBy: "maintainer" })) return load(id)!;
  return pay(b.id);
}

/** Maintainer path. A rejected bounty reopens: the next merged PR that claims the issue starts a fresh claim. */
export async function reject(id: string): Promise<Bounty> {
  const b = load(id);
  if (!b) throw new Error(`unknown bounty ${id}`);
  const done = move(b.id, "reject", {});
  if (done) await comment(done.repo, done.pr, "BountyPay: a maintainer declined to pay this bounty from this PR.");
  return done ?? load(id)!;
}

/** PayPal webhook path. Writes only payout_status, never `state`, and ignores events older than the stored one. */
export function recordPayoutStatus(batchId: string, status: PayoutStatus, at: string): void {
  db()
    .prepare(
      `UPDATE bounties SET payout_status = ?, payout_status_at = ?
       WHERE payout_batch_id = ? AND (payout_status_at IS NULL OR payout_status_at <= ?)`,
    )
    .run(status, at, batchId, at);
}

const MAINTAINER_MOVES = (Object.keys(MOVES) as Move[]).filter(
  (m): m is MaintainerMove => MOVES[m].by === "maintainer",
);

/** Dashboard read, newest first. */
export function listBounties(): Row[] {
  return db()
    .prepare("SELECT * FROM bounties ORDER BY updated_at DESC")
    .all()
    .map(toBounty)
    .map((b) => ({
      ...b,
      actions: MAINTAINER_MOVES.filter((m) => (MOVES[m].from as readonly State[]).includes(b.state)),
    }));
}

/** The one payout path. A row that is not `paying` is returned untouched. */
async function pay(id: BountyId): Promise<Bounty> {
  const b = load(id)!;
  if (b.state !== "paying") return b;
  const r = await sendPayout({
    claimKey: `${b.id}@${b.pr}`,
    to: b.payee,
    amount: b.amount,
    note: `Bounty for ${b.id}, PR #${b.pr}`,
  });
  const done = r.ok
    ? move(id, "payoutSent", { payoutBatchId: r.batchId, payoutStatus: "pending" })
    : move(id, "payoutError", { error: r.error });
  if (done) {
    await comment(
      done.repo,
      done.pr,
      done.state === "sent"
        ? `BountyPay: sent ${usd(done.amount)} through PayPal (payout batch ${done.payoutBatchId}). Thank you!`
        : "BountyPay: PayPal declined the payout. A maintainer will follow up.",
    );
  }
  return done ?? load(id)!;
}

function heldNotice(b: Bounty & { state: "held" }): string {
  return `BountyPay: this ${usd(b.amount)} bounty is waiting for maintainer review (${b.reason.replaceAll("_", " ")}).`;
}

const COLUMNS: Record<string, string> = {
  verdict: "verdict",
  reason: "reason",
  approvedBy: "approved_by",
  payoutBatchId: "payout_batch_id",
  payoutStatus: "payout_status",
  error: "error",
};

/**
 * Atomic compare-and-swap, and the only function that changes `state`.
 * Returns the updated row when this caller won, null when another actor moved it first.
 */
export function move<M extends Move>(
  id: BountyId,
  m: M,
  patch: Partial<Patch<(typeof MOVES)[M]["to"]>>,
): Bounty | null {
  const { from, to } = MOVES[m];
  const sets = ["state = ?", "updated_at = ?"];
  const values: SQLInputValue[] = [to, new Date().toISOString()];
  for (const [key, value] of Object.entries(patch)) {
    sets.push(`${COLUMNS[key]} = ?`);
    values.push(key === "verdict" ? (value ? JSON.stringify(value) : null) : (value as SQLInputValue));
  }
  const row = db()
    .prepare(
      `UPDATE bounties SET ${sets.join(", ")} WHERE id = ? AND state IN (${from.map(() => "?").join(", ")}) RETURNING *`,
    )
    .get(...values, id, ...from);
  return row ? toBounty(row) : null;
}

/**
 * Opens the claim, or reopens a bounty another PR's claim had rejected. Returns whatever is stored,
 * so a second PR for a claimed issue gets the first PR's row back and a redelivery gets its own.
 */
export function insertClaim(c: Claim): Bounty {
  db()
    .prepare(
      `INSERT INTO bounties (id, repo, issue, pr, pr_url, amount, payee, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'judging', ?)
       ON CONFLICT(id) DO UPDATE SET
         pr = excluded.pr, pr_url = excluded.pr_url, amount = excluded.amount, payee = excluded.payee,
         state = 'judging', verdict = NULL, reason = NULL, approved_by = NULL, error = NULL,
         updated_at = excluded.updated_at
       WHERE bounties.state = 'rejected' AND bounties.pr != excluded.pr`,
    )
    .run(c.id, c.repo, c.issue, c.pr, c.prUrl, c.amount, c.payee, new Date().toISOString());
  return load(c.id)!;
}

function load(id: string): Bounty | undefined {
  const row = db().prepare("SELECT * FROM bounties WHERE id = ?").get(id);
  return row ? toBounty(row) : undefined;
}

/** Storage boundary: row columns to the union, verdict JSON through the zod schema. */
function toBounty(row: Record<string, SQLInputValue>): Bounty {
  const claim = {
    id: row.id as BountyId,
    repo: row.repo as string,
    issue: row.issue as number,
    pr: row.pr as number,
    prUrl: row.pr_url as string,
    amount: row.amount as Cents,
    payee: row.payee as Email,
    updatedAt: row.updated_at as string,
  };
  const verdict = row.verdict ? Verdict.parse(JSON.parse(row.verdict as string)) : null;
  const approvedBy = row.approved_by as Approver;
  const state = row.state as State;
  switch (state) {
    case "judging":
      return { ...claim, state };
    case "held":
      return { ...claim, state, verdict, reason: row.reason as HoldReason };
    case "paying":
      return { ...claim, state, verdict, approvedBy };
    case "sent":
      return {
        ...claim,
        state,
        verdict,
        approvedBy,
        payoutBatchId: row.payout_batch_id as string,
        payoutStatus: row.payout_status as PayoutStatus,
      };
    case "failed":
      return { ...claim, state, verdict, approvedBy, error: row.error as string };
    case "rejected":
      return { ...claim, state, verdict };
  }
}

let handle: DatabaseSync | undefined;

function db(): DatabaseSync {
  if (handle) return handle;
  handle = new DatabaseSync(process.env.BOUNTYPAY_DB ?? "bountypay.db");
  handle.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS bounties (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      issue INTEGER NOT NULL,
      pr INTEGER NOT NULL,
      pr_url TEXT NOT NULL,
      amount INTEGER NOT NULL,
      payee TEXT NOT NULL,
      state TEXT NOT NULL,
      verdict TEXT,
      reason TEXT,
      approved_by TEXT,
      payout_batch_id TEXT,
      payout_status TEXT,
      payout_status_at TEXT,
      error TEXT,
      updated_at TEXT NOT NULL
    )`);
  return handle;
}
