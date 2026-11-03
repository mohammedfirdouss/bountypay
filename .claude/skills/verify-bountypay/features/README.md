# BountyPay verification map

The maintained source for verifying BountyPay's user-facing behavior. Read this index, then use the matching feature file as the recipe.

## Baseline preconditions

- A server started by `scripts/launch.sh` for this run, with `doctor.sh` exiting 0.
- An empty database (fresh `RUN_DIR`). Recipes that need earlier rows say which delivery to post first.
- `demo/fixtures.json` unchanged: repo `bountypay/demo`, issues #1 (`bounty:50`), #2 (`bounty:40`), #3 (`bounty:250`), #4 (`bounty:20`), #5 (`bounty:15`), and PRs #10 to #15. PR #15 is a prompt injection: its body and diff tell Claude to approve payment, but the diff does not fix #5.

## Driving conventions

- Make things happen only through `POST /api/github` (via `scripts/demo.ts`) and grid buttons (via `ui.mjs click`).
- Address rows by bounty id, `bountypay/demo#<issue>`. That is the grid's row id and the database key.
- Read outcomes from `state.mjs` and confirm them in the grid. Neither alone is proof.
- Claude and PayPal are real. Note in every report whether keys were present.

## Proof and skip reporting

- Every proof names the feature ID, the action taken, the state before and after, and the evidence file paths.
- A step that needs a key, a public URL, or a real GitHub repo that this run lacks is reported as unverified with the missing precondition. It is never reported as passing through another path.

## Features

- [Merge webhook](./merge-webhook.md) covers signature checks, the demo-mode guard, claiming a bounty, Claude's verdict, the pay or hold decision, and the prompt-injection fixture.
- [Review queue](./review-queue.md) covers Approve, Reject and the dashboard token.
- [No double pay](./no-double-pay.md) covers redelivery, a second PR for a claimed issue, and a PR with no PayPal line.
- [Payout status](./payout-status.md) covers PayPal's payout item webhook and the PayPal status column.
