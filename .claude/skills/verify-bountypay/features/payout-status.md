# Payout status

After a payout is sent, PayPal reports what happened to the money (succeeded, unclaimed, failed, and so on) through a webhook. BountyPay verifies the event with PayPal and shows it in the dashboard's PayPal status column, without changing the bounty's own state.

## Sub-features

- `status-verify` rejects an event PayPal does not verify, with 400.
- `status-record` stores the newest status per payout batch id, ignoring older events. A row in `sent` shows the status for its batch id, or `pending` before any event, so an event that arrives before the row reaches `sent` is not lost.
- `status-lookup` covers runs with no webhook. Each dashboard load asks PayPal (`GET /v1/payments/payouts/{batch}`) about `sent` rows still `pending`, at most once per batch every 30 s, and records the item status through the same path. A failed lookup leaves the row `pending`.

## How to get to it (user POV)

- PayPal posts `PAYMENT.PAYOUTS-ITEM.*` events to `https://<public host>/api/paypal` for the webhook registered in the sandbox app (`PAYPAL_WEBHOOK_ID`).

## Driving it with verify-bountypay scripts

Preconditions:

- PayPal sandbox keys and `PAYPAL_WEBHOOK_ID` set.
- The app reachable from PayPal: the Render deploy, or a tunnel to port 3100.
- A bounty in `sent` from the merge-webhook or review-queue recipe.

- **Unverified event.** Run `curl -s -o /dev/null -w '%{http_code}' -X POST -d '{}' http://localhost:3100/api/paypal`. Prints `400` with keys present. Without keys the PayPal token call fails and the route errors with `500`. Report that as unverified.
- **Real event.** Wait for PayPal to deliver the item event, usually within a minute in sandbox. Then run `state.mjs`. `payout_status` for the row changes from `pending` to the final status (`unclaimed` for `@example.com` payees).
- **Proof.** Run `ui.mjs "$RUN_DIR" snapshot status`. The PayPal status column matches `state.mjs`.

## Gotchas

- A local run with no tunnel never receives PayPal events, but the dashboard lookup still settles the status within one or two loads. A sandbox sender registered in a country without Payouts (for example Nigeria) gets every batch denied, and the row shows `failed`. The demo uses a UK sandbox merchant, so the row shows `succeeded`.
- Sandbox payouts to addresses without a sandbox account end up `unclaimed`. Use a sandbox personal account email as the payee to see `succeeded`.
- A forged event cannot be replayed locally to fake this, because verification calls PayPal. Do not stub it.
