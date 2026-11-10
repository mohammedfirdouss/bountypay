import type { HoldReason, PayoutSource, PayoutStatus, Policy, Row, State } from "@/lib/bounty.ts";

export type Approver = Extract<Row, { approvedBy: unknown }>["approvedBy"];

export const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

const dollars = (cents: number) => (cents % 100 === 0 ? `$${cents / 100}` : usd(cents));

export const percent = (x: number) => `${Math.floor(x * 100 + 1e-9)}%`;

export const verdictOf = (r: Row) => ("verdict" in r ? r.verdict : null);

export const approverOf = (r: Row): Approver | null => ("approvedBy" in r ? r.approvedBy : null);

export const STATES: Record<State, { label: string; hint: string }> = {
  judging: { label: "Judging", hint: "Claude is reading the diff" },
  held: { label: "Held", hint: "Waiting for a maintainer to approve or reject" },
  paying: { label: "Paying", hint: "Sending to PayPal" },
  sent: { label: "Sent", hint: "PayPal accepted the payout" },
  failed: { label: "Failed", hint: "PayPal did not take the payout, and Approve retries it" },
  rejected: { label: "Rejected", hint: "A maintainer declined to pay this PR" },
};

export const APPROVERS: Record<Approver, { label: string; hint: string }> = {
  claude: { label: "Claude", hint: "Claude paid it automatically. It was confident enough and the bounty was under the auto-pay limit" },
  maintainer: { label: "Maintainer", hint: "A maintainer approved it from this dashboard, whatever Claude's confidence" },
};

export const PAYOUT_SOURCE: Record<PayoutSource, string> = {
  webhook: "PayPal's webhook",
  lookup: "BountyPay's status check with PayPal",
};

export const PAYPAL: Record<PayoutStatus, string> = {
  pending: "PayPal is still processing the payout",
  succeeded: "The money reached the payee's PayPal account",
  unclaimed: "No PayPal account uses this email yet, and PayPal returns the money after 30 days if nobody claims it",
  held: "PayPal is holding the payout for review",
  failed: "PayPal could not complete the payout",
  returned: "The payout came back unclaimed",
  blocked: "PayPal blocked the payout",
  refunded: "The payout was refunded",
  reversed: "PayPal reversed the payout and returned the money",
  canceled: "The payout was canceled",
  denied: "PayPal denied the payout",
};

/** Short words for the grid and a full sentence for the detail panel, with POLICY's numbers filled in. */
export function holdReason(reason: HoldReason, row: Row, policy: Policy): { short: string; long: string } {
  const confidence = verdictOf(row)?.confidence;
  switch (reason) {
    case "judge_failed":
      return {
        short: "Claude unreachable",
        long: "Claude could not be reached to review the diff. Check the diff yourself before approving.",
      };
    case "refused":
      return { short: "Claude declined", long: "Claude declined to review this PR, so a person has to." };
    case "judged_unresolved":
      return { short: "Not resolved", long: `Claude does not think the diff resolves issue #${row.issue}.` };
    case "low_confidence":
      return {
        short: `Below ${percent(policy.minConfidence)}`,
        long: `Claude is ${percent(confidence ?? 0)} sure. Auto-pay needs at least ${percent(policy.minConfidence)}.`,
      };
    case "over_cap":
      return {
        short: `Over the ${dollars(policy.cap)} limit`,
        long: `${usd(row.amount)} is over the ${dollars(policy.cap)} auto-pay limit, so a maintainer always decides.`,
      };
  }
}

export const holdReasons = (r: Row) => (r.state === "held" ? r.reasons : []);
