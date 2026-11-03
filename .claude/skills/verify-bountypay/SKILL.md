---
name: verify-bountypay
description: Drive the real BountyPay app (Next.js webhook API + AG Grid dashboard) to prove a change works. Launches an isolated demo-mode server, posts signed GitHub merge webhooks, clicks Approve/Reject in a headless browser, and reads the SQLite rows as evidence. Use after any change to lib/, app/, scripts/demo.ts or demo/fixtures.json, or before claiming a BountyPay feature works.
---

# Verify BountyPay

BountyPay pays a contributor through PayPal sandbox Payouts when a merged PR closes a `bounty:<usd>` issue and Claude agrees the diff resolves it. Users touch two surfaces:

- **Webhook API.** GitHub posts `pull_request` and `issue_comment` events to `POST /api/github`. PayPal posts payout item events to `POST /api/paypal`.
- **Dashboard.** `GET /` shows an AG Grid table of bounties with Approve and Reject on rows a maintainer may act on.

All scripts live in `.claude/skills/verify-bountypay/scripts/`. Run them from the repo root. Every run gets its own directory, `RUN_DIR`, under `/tmp/bountypay-verify/`.

## Launch

```sh
RUN_DIR=$(.claude/skills/verify-bountypay/scripts/launch.sh)   # optional arg: a run id
```

- Starts `next dev` on port 3100 (`BOUNTYPAY_VERIFY_PORT` overrides) with `BOUNTYPAY_DEMO=1`, a fresh SQLite file at `$RUN_DIR/bountypay.db`, an empty `DASHBOARD_TOKEN`, and `GITHUB_WEBHOOK_SECRET` (default `bountypay-demo-secret`, saved in `$RUN_DIR/secret`).
- Ready means the dashboard HTML contains `BountyPay`. The script prints `RUN_DIR` only after that. The table is created on the first request, so an empty run directory is a valid start.
- Real keys in `.env.local` (`ANTHROPIC_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`) pass through, so the same launch exercises the real Claude and PayPal sandbox calls when they are present.
- `BOUNTYPAY_DEMO=offline .claude/skills/verify-bountypay/scripts/launch.sh` launches offline mode instead. It blanks the three keys in the server's environment, which wins over `.env.local`, so fixture verdicts stand in for Claude and a built-in stand-in accepts payouts as `OFFLINE-…`. The mode is saved in `$RUN_DIR/mode`.
- It refuses to start if the port is taken or another `next dev` holds this checkout's `.next/dev`. Next allows one dev server per checkout, so two runs cannot share a checkout. Never drive a server this run did not start, including the user's own `npm run dev` on port 3000.

## Doctor

```sh
.claude/skills/verify-bountypay/scripts/doctor.sh "$RUN_DIR"
```

Read-only. Checks the server process is alive, the port belongs to it, the dashboard renders, and a bad webhook signature gets 401. It also reports which external keys are present. Run it first whenever anything looks off. Exit 0 means every check passed.

## Drive

- **Post the demo webhooks.** `GITHUB_WEBHOOK_SECRET=$(cat $RUN_DIR/secret) node scripts/demo.ts --url http://localhost:3100` signs each PR in `demo/fixtures.json` as a merged `pull_request`, then PR #14's author comment as an `issue_comment`, then replays the first PR. Expect `202` for each of the eight lines. Judging runs after the response, so wait about 5 s without keys, or up to 60 s with a real Claude key, before reading state.
- **Read state.** `node .claude/skills/verify-bountypay/scripts/state.mjs "$RUN_DIR" --out "$RUN_DIR/evidence/<name>.json"`. This is the stored truth: `state`, `reason`, `payout_batch_id`, `payout_status` per bounty id (`bountypay/demo#<issue>`).
- **See the dashboard.** `node .claude/skills/verify-bountypay/scripts/ui.mjs "$RUN_DIR" snapshot <name>` writes the grid rows (row id, every visible cell, action buttons) and a screenshot. The last line, `total | id=<n> shown | amount=<sum>`, is the pinned totals row. A fresh page load has no search or filters, so it covers every bounty.
- **Act as the maintainer.** `node .claude/skills/verify-bountypay/scripts/ui.mjs "$RUN_DIR" click 'bountypay/demo#3' Reject <name>` clicks the real button on that row, records any dashboard alert in `<name>.alert.txt`, reloads, and snapshots. Use `Approve` the same way.
- **Server-side comments.** In demo mode the GitHub comments are logged instead of posted: `grep '\[demo comment\]' "$RUN_DIR/server.log"`.

Feature recipes are in [features/README.md](features/README.md). Read the matching file before driving.

## Evidence

Everything goes to `$RUN_DIR/evidence/`, plus `$RUN_DIR/server.log`. Both survive cleanup.

- Drive the real user path: signed webhooks into `/api/github` and real button clicks in the grid. Never call `lib/` functions or write the database directly to make something happen.
- Capture the action and the resulting state: the `demo.ts` output, the state JSON before and after, and the grid snapshot.
- Check side effects alongside the UI: the row in SQLite, and the `[demo comment]` lines in the server log.
- Demo mode replaces only GitHub reads and comments, which the GitHub adapter already isolates. Claude and PayPal are real calls. Without keys they fail closed: judging lands in `held/judge_failed`, and Approve surfaces `PayPal OAuth: 401`. Report those paths as unverified, not as passing.
- Offline mode also replaces Claude and PayPal. It proves the app's own flow end to end with no keys, never the real Claude or PayPal calls. Say which mode each run used.

## Cleanup

```sh
.claude/skills/verify-bountypay/scripts/cleanup.sh "$RUN_DIR"
```

Stops the server's process group (only what `launch.sh` started), deletes the database and the throwaway Chrome profile, and lists the evidence it kept. Run it after every attempt, including failed ones.

## Helpers

| Script | Invocation | Does |
|---|---|---|
| `launch.sh` | `launch.sh [RUN_ID]` | Starts an isolated demo server, prints `RUN_DIR` when ready |
| `doctor.sh` | `doctor.sh RUN_DIR` | Read-only health and identity checks |
| `state.mjs` | `node state.mjs RUN_DIR [--out FILE]` | Dumps bounty rows as JSON, read-only |
| `ui.mjs` | `node ui.mjs RUN_DIR snapshot NAME` or `click BOUNTY_ID Approve\|Reject NAME` | Headless Chrome over DevTools: grid text and screenshot, or a real button click |
| `cleanup.sh` | `cleanup.sh RUN_DIR` | Stops the run's server, removes scratch state, keeps evidence |

`ui.mjs` uses Google Chrome at its default macOS path. Set `CHROME_BIN` to use another Chromium.
