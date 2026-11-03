# PayPal comment

A contributor who merged a bounty PR without a `PayPal:` line gets a comment asking for one. When the PR author then comments `PayPal: you@example.com` on the merged PR, BountyPay claims the bounty exactly as a merge naming that payee would: same judging, same pay-or-hold policy, same guards.

## Sub-features

- `comment-claim` turns the author's `issue_comment` (action `created`) with a `PayPal:` line into a claim, only for a merged PR that earlier got the "no PayPal line" notice.
- `comment-author-only` ignores the comment unless its author is the PR author (`{"ignored":"comment is not from the PR author"}`).
- `comment-once` treats redeliveries of the comment like redeliveries of a merge: one claim, one judgment, one payout.
- `comment-no-override` never changes a PR's existing claim or payee, and never claims for a PR whose merge BountyPay did not see.
- `comment-demo-guard` in demo and offline mode accepts only the payee in a fixture comment for that fixture PR.

## How to get to it (user POV)

- On a real repo, comment on the merged PR (the webhook must include **Issue comments**).
- In demo or offline mode, `scripts/demo.ts` sends PR #14's fixture comment after the merges.

## Driving it with verify-bountypay scripts

Preconditions:

- Fresh run, doctor passing.

- **Post deliveries.** Run `GITHUB_WEBHOOK_SECRET=$(cat $RUN_DIR/secret) node scripts/demo.ts --url http://localhost:3100`. The line `202 PR #14: author comments a PayPal line` is the comment.
- **Notice, then claim.** Run `grep -A2 'bountypay/demo#14' "$RUN_DIR/server.log"`. The first comment says the PR author can comment `PayPal: you@example.com`. Then `state.mjs` shows `bountypay/demo#4` with `pr: 14` and the fixture payee, `sent` offline, or judged by Claude with keys.
- **Not the author.** Sign the same `issue_comment` payload with `comment.user.login` changed and post it with curl and `X-GitHub-Event: issue_comment`. The response is `{"ignored":"comment is not from the PR author"}`.
- **Redelivery.** Post the author's comment again. The response is `202`, and `#4` keeps its `payout_batch_id`, with no second receipt comment for #14 in the log.

## Gotchas

- GitHub sends PR comments as `issue_comment` events whose `issue` is the PR. The author, the PR body and `issue.pull_request.merged_at` come from that payload, so no GitHub read is needed.
- The comment must come after the merge's notice. `demo.ts` waits 1.5 s between deliveries for that.
