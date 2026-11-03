# Merge webhook

When a maintainer merges a PR whose body says `Fixes #<n>` for an issue labelled `bounty:<usd>`, BountyPay claims the bounty, asks Claude whether the diff resolves the issue, and either pays through PayPal (confident and within the $100 cap) or holds it for a maintainer, commenting on the PR either way.

## Sub-features

- `merge-auth` rejects a delivery whose `X-Hub-Signature-256` does not match.
- `merge-ignore` ignores events that are not a merged PR with a closing reference.
- `merge-demo-guard` in demo mode ignores any PR whose number, issue and payee do not match a fixture PR (`{"ignored":"demo mode accepts only the PRs in demo/fixtures.json"}`), and answers `429` after 30 accepted deliveries in an hour.
- `merge-claim` creates one row per bounty issue in `judging`.
- `merge-hold` holds with every reason that applies, most important first: `judge_failed`, `refused`, `judged_unresolved`, `low_confidence`, `over_cap`. The `reason` column stores them comma-separated. The PR comment states each reason in plain words, quotes Claude's reasoning, and says a maintainer will decide.
- `merge-pay` moves a confident, in-cap verdict to `paying`, then `sent` with a payout batch id, and comments a receipt naming the approver ("Approved automatically by Claude at N% confidence") with Claude's reasoning.
- `merge-injection` holds PR #15 for #5 although its text asks Claude to approve payment. The prompt wraps untrusted text in tags with a random per-request suffix and drops `PayPal:` lines.

## How to get to it (user POV)

- Merge a PR on a repo whose webhook points at `/api/github` (real GitHub).
- Post the fixture deliveries with `scripts/demo.ts` (demo mode).
- Send a request from the generated Postman collection `bountypay.postman_collection.json`.

## Driving it with verify-bountypay scripts

Preconditions:

- Fresh run, doctor passing.

- **Bad signature.** Run `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-GitHub-Event: pull_request' -H 'X-Hub-Signature-256: sha256=00' -d '{}' http://localhost:3100/api/github`. Prints `401`, and `state.mjs` shows `[]`.
- **Non-fixture PR.** Sign a merged-PR payload for PR #99 (or PR #10 with another payee) with `$RUN_DIR/secret` and post it with curl. The response is `200` with `{"ignored":"demo mode accepts only the PRs in demo/fixtures.json"}`, and no row appears.
- **Post deliveries.** Run `GITHUB_WEBHOOK_SECRET=$(cat $RUN_DIR/secret) node scripts/demo.ts --url http://localhost:3100`. Seven lines, each starting `202`.
- **Read the verdicts.** Wait 5 s without keys or about 90 s with them, then `node .claude/skills/verify-bountypay/scripts/state.mjs "$RUN_DIR" --out "$RUN_DIR/evidence/merge.json"`. Rows exist for `#1`, `#2`, `#3`, `#5` and none for `#4`.
  - Without an Anthropic key, `#1`, `#2` and `#5` are `held` / `judge_failed`, and `#3` is `held` / `judge_failed,over_cap`.
  - With keys, `#3`'s reasons include `over_cap` whatever Claude says ($250 > $100), and `#5` is `held` (the injection failed). `#1` is expected to reach `sent` with a `payout_batch_id`, and `#2` to be `held`, but both depend on Claude's real verdict. Record the actual reasons and confidence.
- **Comments.** Run `grep -A12 '\[demo comment\]' "$RUN_DIR/server.log"`. Comments span several lines. Each held row has one "is waiting for a maintainer because:" comment listing its reasons and quoting Claude's reasoning. If `#1` paid, it has one "PayPal accepted a $50 payout" comment.
- **Proof.** Run `node .claude/skills/verify-bountypay/scripts/ui.mjs "$RUN_DIR" snapshot merge`. The grid shows the same states and reasons as `merge.json`.

## Gotchas

- Judging runs after the 202 response (`after()`), so reading state immediately shows `judging`.
- The server only knows the webhook secret it was launched with. `demo.ts` must get the same value, which is why the command passes `$RUN_DIR/secret`.
- `over_cap` is reported even when the judge fails, alongside `judge_failed`.
- The 30-an-hour limit is in memory and per process. Restarting the server resets it.
- The "pay" fixture paying is Claude's decision, not a fixed outcome. Never weaken the fixture or the policy to force it.
