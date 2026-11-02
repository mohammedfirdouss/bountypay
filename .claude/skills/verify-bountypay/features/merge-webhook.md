# Merge webhook

When a maintainer merges a PR whose body says `Fixes #<n>` for an issue labelled `bounty:<usd>`, BountyPay claims the bounty, asks Claude whether the diff resolves the issue, and either pays through PayPal (confident and within the $100 cap) or holds it for a maintainer, commenting on the PR either way.

## Sub-features

- `merge-auth` rejects a delivery whose `X-Hub-Signature-256` does not match.
- `merge-ignore` ignores events that are not a merged PR with a closing reference.
- `merge-claim` creates one row per bounty issue in `judging`.
- `merge-hold` holds with a typed reason: `judged_unresolved`, `low_confidence`, `over_cap`, `refused`, or `judge_failed`.
- `merge-pay` moves a confident, in-cap verdict to `paying`, then `sent` with a payout batch id, and comments a receipt.

## How to get to it (user POV)

- Merge a PR on a repo whose webhook points at `/api/github` (real GitHub).
- Post the fixture deliveries with `scripts/demo.ts` (demo mode).
- Send a request from the generated Postman collection `bountypay.postman_collection.json`.

## Driving it with verify-bountypay scripts

Preconditions:

- Fresh run, doctor passing.

- **Bad signature.** Run `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-GitHub-Event: pull_request' -H 'X-Hub-Signature-256: sha256=00' -d '{}' http://localhost:3100/api/github`. Prints `401`, and `state.mjs` shows `[]`.
- **Post deliveries.** Run `GITHUB_WEBHOOK_SECRET=$(cat $RUN_DIR/secret) node scripts/demo.ts --url http://localhost:3100`. Six lines, each starting `202`.
- **Read the verdicts.** Wait 5 s without keys or 60 s with them, then `node .claude/skills/verify-bountypay/scripts/state.mjs "$RUN_DIR" --out "$RUN_DIR/evidence/merge.json"`. Rows exist for `#1`, `#2`, `#3` and none for `#4`.
  - Without an Anthropic key, all three rows are `held` / `judge_failed`.
  - With keys, `#3` is `held` / `over_cap` whatever Claude says ($250 > $100). `#1` is expected to reach `sent` with a `payout_batch_id`, and `#2` to be `held`, but both depend on Claude's real verdict. Record the actual reason and confidence.
- **Comments.** Run `grep '\[demo comment\]' "$RUN_DIR/server.log"`. One "waiting for maintainer review" line per held row, and one "PayPal accepted a $50.00 payout" line if `#1` paid.
- **Proof.** Run `node .claude/skills/verify-bountypay/scripts/ui.mjs "$RUN_DIR" snapshot merge`. The grid shows the same states and reasons as `merge.json`.

## Gotchas

- Judging runs after the 202 response (`after()`), so reading state immediately shows `judging`.
- The server only knows the webhook secret it was launched with. `demo.ts` must get the same value, which is why the command passes `$RUN_DIR/secret`.
- `over_cap` only appears when Claude actually answers. Without a key the judge fails first, so the reason is `judge_failed`.
- The "pay" fixture paying is Claude's decision, not a fixed outcome. Never weaken the fixture or the policy to force it.
