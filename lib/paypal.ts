import { createHash } from "node:crypto";
import type { Cents, Email } from "./bounty.ts";

const BASE = "https://api-m.sandbox.paypal.com";

export const PAYOUT_STATUSES = [
  "pending",
  "succeeded",
  "unclaimed",
  "held",
  "failed",
  "returned",
  "blocked",
  "refunded",
  "canceled",
  "denied",
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export type PayoutResult = { ok: true; batchId: string } | { ok: false; error: string };

let cached: { token: string; expiresAt: number } | undefined;

async function token(): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal OAuth: ${res.status}`);
  const json = await res.json();
  cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
  return cached.token;
}

export function senderBatchId(claimKey: string): string {
  return "bp_" + createHash("sha256").update(claimKey).digest("hex").slice(0, 24);
}

/**
 * At most one payout per claim. PayPal rejects a sender_batch_id used in the last 30 days and links
 * to the original batch, so a repeat after a redelivery, crash, or double click returns that batch.
 * ok:false means PayPal refused for good and created no batch. Network, 401, 429, and 5xx throw.
 */
export async function sendPayout(p: {
  claimKey: string;
  to: Email;
  amount: Cents;
  note: string;
}): Promise<PayoutResult> {
  const id = senderBatchId(p.claimKey);
  const res = await fetch(`${BASE}/v1/payments/payouts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": id,
    },
    body: JSON.stringify({
      sender_batch_header: { sender_batch_id: id, email_subject: "You received a bounty", email_message: p.note },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: p.to,
          amount: { value: (p.amount / 100).toFixed(2), currency: "USD" },
          note: p.note,
          sender_item_id: id,
        },
      ],
    }),
  });
  if (res.status === 401) cached = undefined;
  if (res.status === 401 || res.status === 429 || res.status >= 500) throw new Error(`PayPal payouts: ${res.status}`);
  const json = await res.json();
  if (res.ok) return { ok: true, batchId: json.batch_header.payout_batch_id };
  // PayPal puts the duplicate-batch link in details[].link, not the top-level links.
  const links: { href?: string }[] = [
    ...(json.links ?? []),
    ...(json.details ?? []).flatMap((d: { link?: { href?: string }[] }) => d.link ?? []),
  ];
  const original = links
    .map((l) => /\/v1\/payments\/payouts\/([^/?#]+)/.exec(l.href ?? "")?.[1])
    .find(Boolean);
  if (original) return { ok: true, batchId: original };
  return { ok: false, error: [json.name, json.message].filter(Boolean).join(": ") || `HTTP ${res.status}` };
}

const ITEM_STATUS: Record<string, PayoutStatus> = {
  SUCCESS: "succeeded",
  FAILED: "failed",
  PENDING: "pending",
  UNCLAIMED: "unclaimed",
  RETURNED: "returned",
  ONHOLD: "held",
  BLOCKED: "blocked",
  REFUNDED: "refunded",
  DENIED: "denied",
};

/** Reads the batch's single item status from PayPal. Throws when PayPal does not answer with one. */
export async function fetchPayoutStatus(batchId: string): Promise<PayoutStatus> {
  const res = await fetch(`${BASE}/v1/payments/payouts/${encodeURIComponent(batchId)}`, {
    headers: { Authorization: `Bearer ${await token()}` },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 401) cached = undefined;
  if (!res.ok) throw new Error(`PayPal payout lookup: ${res.status}`);
  const json = await res.json();
  const item = ITEM_STATUS[json.items?.[0]?.transaction_status];
  if (json.batch_header?.batch_status === "DENIED" && (!item || item === "pending")) return "denied";
  if (!item) throw new Error(`PayPal payout lookup: no item status for ${batchId}`);
  return item;
}

export type PayoutEvent =
  | { kind: "status"; batchId: string; status: PayoutStatus; at: string }
  | { kind: "ignored" }
  | { kind: "unauthorized" };

export async function parsePayoutWebhook(raw: string, headers: Headers): Promise<PayoutEvent> {
  const h = (name: string) => JSON.stringify(headers.get(name) ?? "");
  // Splice the raw body in rather than re-serializing it: PayPal checks the event bytes it sent.
  const body = `{"auth_algo":${h("paypal-auth-algo")},"cert_url":${h("paypal-cert-url")},"transmission_id":${h("paypal-transmission-id")},"transmission_sig":${h("paypal-transmission-sig")},"transmission_time":${h("paypal-transmission-time")},"webhook_id":${JSON.stringify(process.env.PAYPAL_WEBHOOK_ID ?? "")},"webhook_event":${raw}}`;
  const res = await fetch(`${BASE}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body,
  });
  if (!res.ok || (await res.json()).verification_status !== "SUCCESS") return { kind: "unauthorized" };

  const event = JSON.parse(raw);
  const m = /^PAYMENT\.PAYOUTS-ITEM\.([A-Z]+)$/.exec(event.event_type ?? "");
  const status = m?.[1].toLowerCase();
  if (!status || !PAYOUT_STATUSES.includes(status as PayoutStatus)) return { kind: "ignored" };
  return { kind: "status", batchId: event.resource.payout_batch_id, status: status as PayoutStatus, at: event.create_time };
}
