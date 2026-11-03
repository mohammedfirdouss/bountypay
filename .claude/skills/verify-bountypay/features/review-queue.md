# Review queue

A maintainer resolves held bounties from the dashboard. Approve pays through the same PayPal path the webhook uses, and Reject closes the claim, comments on the PR, and lets a different PR claim the issue later. When `DASHBOARD_TOKEN` is set, both buttons stay hidden until the token is entered once.

## Sub-features

- `review-buttons` shows Approve and Reject only on rows in `judging`, `held`, `paying` or `failed`. A row stuck in `paying` can be retried, because the PayPal batch id comes from the claim (bounty, PR, payee) and PayPal never pays one batch id twice.
- `review-reject` moves the row to `rejected` and logs a decline comment.
- `review-confirm` asks "Pay <amount> to <payee>?" before Approve pays, in the grid row and in the detail panel. Cancel or Esc leaves the row untouched.
- `review-approve` moves the row to `paying`, then `sent` (PayPal accepted) or `failed` (PayPal refused, errored, or timed out after 10 s). The receipt says "Approved by a maintainer", and a failure comment says a maintainer can retry.
- `review-token` hides actions behind the `Dashboard token` field when `DASHBOARD_TOKEN` is set.

## How to get to it (user POV)

- Open the dashboard at `/` and use the Approve or Reject button in the pinned Actions column of a row.

## Driving it with verify-bountypay scripts

Preconditions:

- The merge-webhook deliveries have been posted and `#2` and `#3` are `held`.

- **Buttons present.** Run `node .claude/skills/verify-bountypay/scripts/ui.mjs "$RUN_DIR" snapshot review-before`. Held rows end with `buttons=Approve,Reject`.
- **Reject.** Run `node .claude/skills/verify-bountypay/scripts/ui.mjs "$RUN_DIR" click 'bountypay/demo#3' Reject review-reject`. The snapshot shows `#3` in `rejected` with no buttons. `state.mjs` agrees, and the server log has `[demo comment] bountypay/demo#12: BountyPay: a maintainer declined to pay the $250 bounty`.
- **Approve.** Run `node .claude/skills/verify-bountypay/scripts/ui.mjs "$RUN_DIR" click 'bountypay/demo#2' Approve review-approve`.
  - With PayPal keys, the row ends `sent` with a `payout_batch_id`, and the log has a "PayPal accepted a $40 payout" comment.
  - Without them, the row ends `failed` with error `PayPal OAuth: 401`, and the log has a "PayPal did not confirm the $40 payout" comment. Report the payout as unverified.
- **Proof.** Save `state.mjs --out "$RUN_DIR/evidence/review.json"` alongside the snapshots.

## Gotchas

- `review-token` needs a server launched with a non-empty `DASHBOARD_TOKEN`. `launch.sh` passes through an exported value and defaults to empty, so cover it in a separate run with `DASHBOARD_TOKEN=x` exported before launching, and edit nothing else.
- A payout that throws (network, 401, 429, 5xx, timeout) lands in `failed`, not `paying`. A row only stays `paying` while a payout is in flight or after a crash. Approve retries it, and a redelivery of the merge resumes it too.
- Rows are keyed by issue (`#3`), but comments go to the PR (`#12`). Grep the log by PR number.
