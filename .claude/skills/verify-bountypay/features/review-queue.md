# Review queue

A maintainer resolves held bounties from the dashboard. Approve pays through the same PayPal path the webhook uses, and Reject closes the claim, comments on the PR, and lets a different PR claim the issue later. When `DASHBOARD_TOKEN` is set, both buttons stay hidden until the token is entered once.

## Sub-features

- `review-buttons` shows Approve and Reject only on rows in `judging`, `held` or `failed`.
- `review-reject` moves the row to `rejected` and logs a decline comment.
- `review-approve` moves the row to `paying`, then `sent` (PayPal accepted) or `failed` (PayPal refused).
- `review-token` hides actions behind the `Dashboard token` field when `DASHBOARD_TOKEN` is set.

## How to get to it (user POV)

- Open the dashboard at `/` and use the Approve or Reject button in the pinned Actions column of a row.

## Driving it with verify-bountypay scripts

Preconditions:

- The merge-webhook deliveries have been posted and `#2` and `#3` are `held`.

- **Buttons present.** Run `node .claude/skills/verify-bountypay/scripts/ui.mjs "$RUN_DIR" snapshot review-before`. Held rows end with `buttons=Approve,Reject`.
- **Reject.** Run `node .claude/skills/verify-bountypay/scripts/ui.mjs "$RUN_DIR" click 'bountypay/demo#3' Reject review-reject`. The snapshot shows `#3` in `rejected` with no buttons. `state.mjs` agrees, and the server log has `[demo comment] bountypay/demo#12: BountyPay: a maintainer declined`.
- **Approve.** Run `node .claude/skills/verify-bountypay/scripts/ui.mjs "$RUN_DIR" click 'bountypay/demo#2' Approve review-approve`.
  - With PayPal keys, the row ends `sent` with a `payout_batch_id`, and the log has a "sent $40.00" comment.
  - Without them, the run writes `review-approve.alert.txt` containing `PayPal OAuth: 401` and the row stays `paying`. Report the payout as unverified.
- **Proof.** Save `state.mjs --out "$RUN_DIR/evidence/review.json"` alongside the snapshots.

## Gotchas

- `review-token` needs a server launched with a non-empty `DASHBOARD_TOKEN`. `launch.sh` clears it, so cover it in a separate run with `DASHBOARD_TOKEN=x` exported before launching, and edit nothing else.
- A `paying` row has no buttons. It resumes on the next webhook redelivery for that PR, not from the dashboard.
- Rows are keyed by issue (`#3`), but comments go to the PR (`#12`). Grep the log by PR number.
