# No double pay

A bounty pays at most once. Redelivering the same merge, merging a second PR that claims the same issue, or double-clicking Approve never creates a second payout. A bounty PR without a `PayPal:` line gets a comment instead of a claim.

## Sub-features

- `once-replay` treats a redelivered merge as a no-op, or a resume if the earlier run crashed.
- `once-double-claim` keeps the first PR's claim and comments "already claimed" on the second PR.
- `once-no-payee` comments asking for a `PayPal:` line and creates no row.
- `once-notice` posts the "already claimed" and "add a PayPal line" comments at most once per PR, however often the merge is redelivered.
- `once-batch-key` reuses the same PayPal `sender_batch_id` for every retry of one claim.

## How to get to it (user POV)

- GitHub's "Redeliver" button on a webhook delivery.
- A second contributor's PR with `Fixes #1` merged after PR #10.
- A merged bounty PR whose body has no `PayPal:` line.

## Driving it with verify-bountypay scripts

Preconditions:

- Fresh run, doctor passing.

- **Post deliveries.** Run `GITHUB_WEBHOOK_SECRET=$(cat $RUN_DIR/secret) node scripts/demo.ts --url http://localhost:3100`. Its last line is the replay of PR #10, and PR #13 also claims issue #1.
- **One row per issue.** Run `node .claude/skills/verify-bountypay/scripts/state.mjs "$RUN_DIR" --out "$RUN_DIR/evidence/once.json"`. `bountypay/demo#1` has `pr: 10`, not 13, and there is exactly one row for it.
- **Comments.** Run `grep '\[demo comment\]' "$RUN_DIR/server.log"`. The log has `bountypay/demo#13: ... already claimed by #10` and `bountypay/demo#14: ... no \`PayPal: you@example.com\` line`. It has only one held or receipt comment for PR #10, despite the replay.
- **No row for #4.** `once.json` has no `bountypay/demo#4`.
- **Notices once.** Run the demo script a second time, then `grep -c 'already claimed' "$RUN_DIR/server.log"` and ``grep -c 'no `PayPal:' "$RUN_DIR/server.log"``. Each prints `1`.
- **Batch key (keys present).** If `#1` reached `sent`, run the demo script again. `payout_batch_id` for `#1` is unchanged and no new receipt comment appears.

## Gotchas

- The "already claimed" and "add a PayPal line" comments are gated by a `notices` row per (repo, PR, kind), not by the bounty's state. A fresh `RUN_DIR` starts with no notices, so each appears once per run.
- The replay proves idempotency only after the first delivery has finished judging. `demo.ts` waits 1.5 s between deliveries. With a slow real Claude call the replay may arrive mid-judgment, which is also safe, because the compare-and-swap means only one verdict lands.
