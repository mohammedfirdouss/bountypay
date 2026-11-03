import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { comment, fetchBountyIssue, fetchDiff, type MergedPr } from "./github.ts";
import { judge, Verdict } from "./judge.ts";
import { fetchPayoutStatus, sendPayout, type PayoutResult, type PayoutStatus } from "./paypal.ts";

export type BountyId = string & { readonly __brand: "BountyId" };
export type Cents = number & { readonly __brand: "Cents" };
export type Email = string & { readonly __brand: "Email" };
export type { PayoutStatus };

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

export type Bounty = Claim & { updatedAt: string } & (
    | { state: "judging" }
    | { state: "held"; verdict: Verdict | null; reason: HoldReason }
    | { state: "paying"; verdict: Verdict | null; approvedBy: Approver }
    | { state: "sent"; verdict: Verdict | null; approvedBy: Approver; payoutBatchId: string; payoutStatus: PayoutStatus }
    | { state: "failed"; verdict: Verdict | null; approvedBy: Approver; error: string }
    | { state: "rejected"; verdict: Verdict | null }
  );
export type State = Bounty["state"];

const MOVES = {
  claim: { by: "github", from: ["rejected"], to: "judging" },
  verdictPay: { by: "claude", from: ["judging"], to: "paying" },
  verdictHold: { by: "claude", from: ["judging"], to: "held" },
  approve: { by: "maintainer", from: ["judging", "held", "paying", "failed"], to: "paying" },
  reject: { by: "maintainer", from: ["judging", "held", "paying", "failed"], to: "rejected" },
  // PayPal accepting the batch is final, even if a maintainer gave up on a stuck row meanwhile.
  payoutSent: { by: "paypal", from: ["paying", "failed", "rejected"], to: "sent" },
  payoutError: { by: "paypal", from: ["paying"], to: "failed" },
} as const satisfies Record<string, { by: string; from: readonly State[]; to: State }>;
type Move = keyof typeof MOVES;
type MaintainerMove = { [M in Move]: (typeof MOVES)[M]["by"] extends "maintainer" ? M : never }[Move];

type Patch<S extends State> = Omit<Extract<Bounty, { state: S }>, keyof Claim | "state" | "updatedAt" | "payoutStatus">;

export type Row = Bounty & { actions: MaintainerMove[] };

export type Policy = { minConfidence: number; cap: Cents };
export type Decision = { next: "pay" } | { next: "hold"; reason: HoldReason };

export const POLICY: Policy = { minConfidence: 0.8, cap: 100_00 as Cents };

export function decide(claim: Claim, verdict: Verdict | "refused", policy: Policy = POLICY): Decision {
  if (verdict === "refused") return { next: "hold", reason: "refused" };
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
    if (firstNotice(merge.repo, merge.pr, "no_payee")) await comment(merge.repo, merge.pr, "BountyPay: this PR closes a bounty issue but has no `PayPal: you@example.com` line, so no payout was started. Add the line and ask a maintainer to redeliver the merge webhook.");
    return;
  }
  const id = bountyId(merge.repo, merge.issue);
  const stored = insertClaim({ ...merge, id, amount: issue.amount, payee: merge.payee });
  if (stored.pr !== merge.pr) {
    if (firstNotice(merge.repo, merge.pr, "claimed")) await comment(merge.repo, merge.pr, `BountyPay: the bounty on #${merge.issue} is already claimed by #${stored.pr}.`);
    return;
  }

  if (stored.state === "judging") {
    let verdict: Verdict | "refused";
    try {
      verdict = await judge({ issue, pr: merge, diff: await fetchDiff(merge.repo, merge.pr) });
    } catch (e) {
      console.error(`judge failed for ${id}:`, e);
      const held = move(id, "verdictHold", { verdict: null, reason: "judge_failed" });
      if (held) await comment(held.repo, held.pr, heldNotice(held));
      return;
    }
    const d = decide(stored, verdict);
    const kept = verdict === "refused" ? null : verdict;
    if (d.next === "hold") {
      const held = move(id, "verdictHold", { verdict: kept, reason: d.reason });
      if (held) await comment(held.repo, held.pr, heldNotice(held));
      return;
    }
    move(id, "verdictPay", { verdict: kept, approvedBy: "claude" });
  }
  await resumePayout(id);
}

export async function approve(id: string): Promise<Bounty> {
  const b = load(id);
  if (!b) throw new Error(`unknown bounty ${id}`);
  if (!move(b.id, "approve", { approvedBy: "maintainer" })) return load(id)!;
  return resumePayout(b.id);
}

export async function reject(id: string): Promise<Bounty> {
  const b = load(id);
  if (!b) throw new Error(`unknown bounty ${id}`);
  const done = move(b.id, "reject", {});
  if (done) await comment(done.repo, done.pr, "BountyPay: a maintainer declined to pay this bounty from this PR.");
  return done ?? load(id)!;
}

export function recordPayoutStatus(batchId: string, status: PayoutStatus, at: string): void {
  db()
    .prepare(
      `INSERT INTO payout_status (batch_id, status, at) VALUES (?, ?, ?)
       ON CONFLICT(batch_id) DO UPDATE SET status = excluded.status, at = excluded.at
       WHERE excluded.at >= payout_status.at`,
    )
    .run(batchId, status, at);
}

const LOOKUP_EVERY_MS = 30_000;
const lastLookup = new Map<string, number>();

/**
 * Asks PayPal about sent payouts that no webhook has settled, at most once per batch every 30 s, and
 * records the answer as if the webhook had sent it. Never throws: a failed lookup leaves the row pending.
 */
export async function checkPendingPayouts(): Promise<void> {
  const now = Date.now();
  const due = db()
    .prepare(
      `SELECT DISTINCT payout_batch_id AS id FROM (SELECT payout_batch_id, ${PAYPAL_STATUS} FROM bounties WHERE state = 'sent')
       WHERE paypal_status IS NULL OR paypal_status = 'pending'`,
    )
    .all()
    .map((r) => r.id as string)
    .filter((id) => now - (lastLookup.get(id) ?? 0) >= LOOKUP_EVERY_MS);
  await Promise.all(
    due.map(async (id) => {
      lastLookup.set(id, now);
      try {
        const status = await fetchPayoutStatus(id);
        if (status !== "pending") recordPayoutStatus(id, status, new Date().toISOString());
      } catch (e) {
        console.error(`payout lookup failed for ${id}:`, e);
      }
    }),
  );
}

const MAINTAINER_MOVES = (Object.keys(MOVES) as Move[]).filter(
  (m): m is MaintainerMove => MOVES[m].by === "maintainer",
);

export function listBounties(): Row[] {
  return db()
    .prepare(`SELECT *, ${PAYPAL_STATUS} FROM bounties ORDER BY updated_at DESC`)
    .all()
    .map(toBounty)
    .map((b) => ({
      ...b,
      actions: MAINTAINER_MOVES.filter((m) => (MOVES[m].from as readonly State[]).includes(b.state)),
    }));
}

async function resumePayout(id: BountyId): Promise<Bounty> {
  const b = load(id)!;
  if (b.state !== "paying") return b;
  let r: PayoutResult;
  try {
    r = await sendPayout({
      claimKey: `${b.id}@${b.pr}:${b.payee}`,
      to: b.payee,
      amount: b.amount,
      note: `Bounty for ${b.id}, PR #${b.pr}`,
    });
  } catch (e) {
    console.error(`payout failed for ${id}:`, e);
    r = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const done = r.ok
    ? move(id, "payoutSent", { payoutBatchId: r.batchId })
    : move(id, "payoutError", { error: r.error });
  if (done) {
    await comment(
      done.repo,
      done.pr,
      done.state === "sent"
        ? `BountyPay: PayPal accepted a ${usd(done.amount)} payout for this PR (payout batch ${done.payoutBatchId}). Thank you!`
        : "BountyPay: PayPal declined the payout. A maintainer will follow up.",
    );
  }
  return done ?? load(id)!;
}

function heldNotice(b: Bounty & { state: "held" }): string {
  return `BountyPay: this ${usd(b.amount)} bounty is waiting for maintainer review (${b.reason.replaceAll("_", " ")}).`;
}

const PAYPAL_STATUS = "(SELECT status FROM payout_status WHERE batch_id = bounties.payout_batch_id) AS paypal_status";

const COLUMNS: Record<string, string> = {
  verdict: "verdict",
  reason: "reason",
  approvedBy: "approved_by",
  payoutBatchId: "payout_batch_id",
  error: "error",
};

/**
 * Atomic compare-and-swap.
 * Returns the updated row when this caller won, null when another actor moved it first.
 */
export function move<M extends Move>(
  id: BountyId,
  m: M,
  patch: Partial<Patch<(typeof MOVES)[M]["to"]>>,
): Extract<Bounty, { state: (typeof MOVES)[M]["to"] }> | null {
  const { from, to } = MOVES[m];
  const sets = ["state = ?", "updated_at = ?"];
  const values: SQLInputValue[] = [to, new Date().toISOString()];
  for (const [key, value] of Object.entries(patch)) {
    sets.push(`${COLUMNS[key]} = ?`);
    values.push(key === "verdict" ? (value ? JSON.stringify(value) : null) : (value as SQLInputValue));
  }
  const row = db()
    .prepare(
      `UPDATE bounties SET ${sets.join(", ")} WHERE id = ? AND state IN (${from.map(() => "?").join(", ")}) RETURNING *, ${PAYPAL_STATUS}`,
    )
    .get(...values, id, ...from);
  return row ? (toBounty(row) as Extract<Bounty, { state: (typeof MOVES)[M]["to"] }>) : null;
}

/**
 * Opens the claim, or reopens a bounty another PR's claim had rejected. Returns whatever is stored,
 * so a second PR for a claimed issue gets the first PR's row back and a redelivery gets its own.
 */
export function insertClaim(c: Claim): Bounty {
  db()
    .prepare(
      `INSERT INTO bounties (id, repo, issue, pr, pr_url, amount, payee, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         pr = excluded.pr, pr_url = excluded.pr_url, amount = excluded.amount, payee = excluded.payee,
         state = excluded.state, verdict = NULL, reason = NULL, approved_by = NULL, error = NULL,
         updated_at = excluded.updated_at
       WHERE bounties.state IN (${MOVES.claim.from.map(() => "?").join(", ")}) AND bounties.pr != excluded.pr`,
    )
    .run(c.id, c.repo, c.issue, c.pr, c.prUrl, c.amount, c.payee, MOVES.claim.to, new Date().toISOString(), ...MOVES.claim.from);
  return load(c.id)!;
}

function firstNotice(repo: string, pr: number, kind: "no_payee" | "claimed"): boolean {
  const r = db().prepare("INSERT INTO notices (repo, pr, kind) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(repo, pr, kind);
  return r.changes > 0;
}

function load(id: string): Bounty | undefined {
  const row = db().prepare(`SELECT *, ${PAYPAL_STATUS} FROM bounties WHERE id = ?`).get(id);
  return row ? toBounty(row) : undefined;
}

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
        payoutStatus: (row.paypal_status as PayoutStatus | null) ?? "pending",
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
      error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notices (
      repo TEXT NOT NULL,
      pr INTEGER NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (repo, pr, kind)
    );
    CREATE TABLE IF NOT EXISTS payout_status (
      batch_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      at TEXT NOT NULL
    )`);
  return handle;
}
