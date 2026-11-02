import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import type { Claim, Cents, Email } from "./bounty.ts";
import type { MergedPr } from "./github.ts";

process.env.BOUNTYPAY_DB = ":memory:";
process.env.BOUNTYPAY_DEMO = "1";
process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.PAYPAL_CLIENT_ID = "id";
process.env.PAYPAL_CLIENT_SECRET = "secret";

const { approve, bountyId, checkPendingPayouts, decide, ingest, insertClaim, listBounties, move, recordPayoutStatus, reject } =
  await import(
  "./bounty.ts"
);
const { parseBountyLabel, parseIssueRef, parseMergeWebhook, parsePayee, sign } = await import("./github.ts");

const claim = (over: Partial<Claim> = {}): Claim => ({
  id: bountyId("o/r", 1),
  repo: "o/r",
  issue: 1,
  pr: 10,
  prUrl: "https://github.com/o/r/pull/10",
  amount: 50_00 as Cents,
  payee: "ada@example.com" as Email,
  ...over,
});
const verdict = (decision: "pay" | "hold", confidence: number) => ({ decision, confidence, reasoning: "r" });
const row = (id: string) => listBounties().find((b) => b.id === id)!;

describe("decide", () => {
  test("a confident pay verdict within the cap pays", () => {
    assert.deepEqual(decide(claim(), verdict("pay", 0.9)), { next: "pay" });
  });
  test("a confident pay verdict over the cap is held", () => {
    assert.deepEqual(decide(claim({ amount: 250_00 as Cents }), verdict("pay", 0.99)), { next: "hold", reason: "over_cap" });
  });
  test("low confidence is held even under the cap", () => {
    assert.deepEqual(decide(claim(), verdict("pay", 0.79)), { next: "hold", reason: "low_confidence" });
  });
  test("a hold verdict is held", () => {
    assert.deepEqual(decide(claim(), verdict("hold", 0.95)), { next: "hold", reason: "judged_unresolved" });
  });
  test("a refusal is held", () => {
    assert.deepEqual(decide(claim(), "refused"), { next: "hold", reason: "refused" });
  });
});

describe("parse helpers", () => {
  test("closing keywords name the issue", () => {
    assert.equal(parseIssueRef("Fixes #12"), 12);
    assert.equal(parseIssueRef("this closes #3 finally"), 3);
    assert.equal(parseIssueRef("Resolved #7"), 7);
    assert.equal(parseIssueRef("relates to #4"), null);
  });
  test("the PayPal line names the payee", () => {
    assert.equal(parsePayee("Fixes #1\nPayPal: ada@example.com\n"), "ada@example.com");
    assert.equal(parsePayee("paypal:  bob@example.co.uk"), "bob@example.co.uk");
    assert.equal(parsePayee("PayPal: not-an-email"), null);
    assert.equal(parsePayee("Pay me at ada@example.com"), null);
  });
  test("bounty labels parse to cents", () => {
    assert.equal(parseBountyLabel(["bug", "bounty:50"]), 50_00);
    assert.equal(parseBountyLabel(["bounty:12.5"]), 12_50);
    assert.equal(parseBountyLabel(["bounty:abc", "bug"]), null);
  });
  test("the merge webhook needs a valid signature", () => {
    const raw = JSON.stringify({
      action: "closed",
      repository: { full_name: "o/r" },
      pull_request: { merged: true, number: 10, html_url: "u", title: "t", body: "Fixes #1\nPayPal: a@b.co" },
    });
    const headers = (sig: string, event = "pull_request") =>
      new Headers({ "x-hub-signature-256": sig, "x-github-event": event });
    assert.deepEqual(parseMergeWebhook(raw, headers(sign(raw, "wrong"))), { kind: "unauthorized" });
    const ok = parseMergeWebhook(raw, headers(sign(raw, "test-secret")));
    assert.equal(ok.kind, "merged");
    assert.equal(ok.kind === "merged" && ok.pr.payee, "a@b.co");
    assert.equal(parseMergeWebhook(raw, headers(sign(raw, "test-secret"), "issues")).kind, "ignored");
  });
});

describe("store", () => {
  test("one claim per issue: a second PR gets the first PR's row back", () => {
    const id = bountyId("s/claim", 1);
    assert.equal(insertClaim(claim({ id, pr: 10 })).pr, 10);
    assert.equal(insertClaim(claim({ id, pr: 11 })).pr, 10);
  });
  test("compare-and-swap: of two approves, exactly one wins", () => {
    const id = bountyId("s/cas", 1);
    insertClaim(claim({ id }));
    move(id, "verdictHold", { verdict: verdict("hold", 0.9), reason: "judged_unresolved" });
    const wins = [move(id, "approve", { approvedBy: "maintainer" }), move(id, "approve", { approvedBy: "maintainer" })];
    assert.equal(wins.filter(Boolean).length, 1);
    assert.equal(move(id, "reject", {}), null, "a paying row cannot be rejected");
  });
  test("held rows offer approve and reject, sent rows offer nothing", () => {
    const id = bountyId("s/actions", 1);
    insertClaim(claim({ id }));
    move(id, "verdictHold", { verdict: null, reason: "judge_failed" });
    assert.deepEqual(row(id).actions, ["approve", "reject"]);
    move(id, "approve", { approvedBy: "maintainer" });
    move(id, "payoutSent", { payoutBatchId: "B1" });
    assert.deepEqual(row(id).actions, []);
  });
  test("a rejected bounty reopens for another PR, not for a redelivery of the rejected one", () => {
    const id = bountyId("s/reopen", 1);
    insertClaim(claim({ id, pr: 10 }));
    move(id, "reject", {});
    assert.equal(insertClaim(claim({ id, pr: 10 })).state, "rejected");
    const reopened = insertClaim(claim({ id, pr: 12 }));
    assert.equal(reopened.state, "judging");
    assert.equal(reopened.pr, 12);
  });
  test("PayPal status never goes backwards", () => {
    const id = bountyId("s/status", 1);
    insertClaim(claim({ id }));
    move(id, "verdictPay", { verdict: verdict("pay", 0.9), approvedBy: "claude" });
    move(id, "payoutSent", { payoutBatchId: "B-status" });
    recordPayoutStatus("B-status", "succeeded", "2026-11-02T10:00:02Z");
    recordPayoutStatus("B-status", "unclaimed", "2026-11-02T10:00:01Z");
    const b = row(id);
    assert.equal(b.state === "sent" && b.payoutStatus, "succeeded");
  });
  test("a PayPal status that arrives before the row is sent is kept", () => {
    const id = bountyId("s/early", 1);
    insertClaim(claim({ id }));
    move(id, "verdictPay", { verdict: verdict("pay", 0.9), approvedBy: "claude" });
    recordPayoutStatus("B-early", "unclaimed", "2026-11-02T10:00:01Z");
    move(id, "payoutSent", { payoutBatchId: "B-early" });
    const b = row(id);
    assert.equal(b.state === "sent" && b.payoutStatus, "unclaimed");
  });
  test("a sent row with no PayPal status yet reads as pending", () => {
    const id = bountyId("s/pending", 1);
    insertClaim(claim({ id }));
    move(id, "verdictPay", { verdict: verdict("pay", 0.9), approvedBy: "claude" });
    move(id, "payoutSent", { payoutBatchId: "B-pending" });
    const b = row(id);
    assert.equal(b.state === "sent" && b.payoutStatus, "pending");
  });
});

describe("flow against fake Claude and PayPal", () => {
  let claudeSays: (prompt: string) => object | "refuse" | "throw";
  let batches: Map<string, string>;
  let comments: string[];
  const lookups = new Map<string, () => Response>();

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://api.anthropic.com/v1/messages")) {
      const said = claudeSays(String(init?.body));
      if (said === "throw") return json(400, { type: "error", error: { type: "invalid_request_error", message: "boom" } });
      return json(200, {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: said === "refuse" ? [] : [{ type: "text", text: JSON.stringify(said) }],
        stop_reason: said === "refuse" ? "refusal" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    if (url.endsWith("/v1/oauth2/token")) return json(200, { access_token: "t", expires_in: 3600 });
    if (url.endsWith("/v1/payments/payouts")) {
      const sid = JSON.parse(String(init?.body)).sender_batch_header.sender_batch_id;
      const existing = batches.get(sid);
      if (existing) {
        return json(400, {
          name: "USER_BUSINESS_ERROR",
          message: "Batch with given sender_batch_id already exists",
          links: [{ href: `https://api-m.sandbox.paypal.com/v1/payments/payouts/${existing}`, rel: "self" }],
        });
      }
      batches.set(sid, `BATCH${batches.size + 1}`);
      return json(201, { batch_header: { payout_batch_id: batches.get(sid), batch_status: "PENDING" } });
    }
    const lookup = /\/v1\/payments\/payouts\/([^/?#]+)$/.exec(url);
    if (lookup) return lookups.get(lookup[1])?.() ?? json(404, { name: "RESOURCE_NOT_FOUND" });
    throw new Error(`unexpected fetch ${url}`);
  };
  const log = console.log;
  console.log = (...args: unknown[]) => {
    if (String(args[0]).startsWith("[demo comment]")) comments.push(String(args[0]));
    else log(...args);
  };

  beforeEach(() => {
    batches = new Map();
    comments = [];
    claudeSays = () => verdict("pay", 0.95);
  });

  const pr = (number: number, issue: number, payee: string | null = `p${number}@example.com`): MergedPr => ({
    repo: "bountypay/demo",
    pr: number,
    prUrl: `https://github.com/bountypay/demo/pull/${number}`,
    title: `PR ${number}`,
    body: `Fixes #${issue}`,
    issue,
    payee: payee as Email | null,
  });

  test("a confident verdict pays once, and a replay of the delivery changes nothing", async () => {
    await ingest(pr(10, 1));
    const b = row("bountypay/demo#1");
    assert.equal(b.state, "sent");
    assert.equal(b.state === "sent" && b.approvedBy, "claude");
    assert.equal(batches.size, 1);
    await ingest(pr(10, 1));
    assert.equal(batches.size, 1);
    assert.equal(comments.length, 1, "one receipt comment");
  });

  test("a second PR for a claimed issue does not pay", async () => {
    await ingest(pr(13, 1));
    assert.equal(row("bountypay/demo#1").pr, 10);
    assert.equal(batches.size, 0);
  });

  test("redeliveries post the already-claimed and missing-PayPal-line comments once", async () => {
    for (let i = 0; i < 3; i++) {
      await ingest(pr(17, 1));
      await ingest(pr(21, 1, null));
    }
    assert.equal(comments.filter((c) => c.includes("already claimed by #10")).length, 1);
    assert.equal(comments.filter((c) => c.includes("no `PayPal:")).length, 1);
    assert.equal(comments.length, 2);
  });

  test("over the cap is held for review, then a double-clicked approve pays once", async () => {
    await ingest(pr(12, 3));
    const held = row("bountypay/demo#3");
    assert.equal(held.state === "held" && held.reason, "over_cap");
    const [a, b] = await Promise.all([approve(held.id), approve(held.id)]);
    assert.deepEqual([a.state, b.state].sort(), ["paying", "sent"]);
    assert.equal(row(held.id).state, "sent");
    assert.equal(batches.size, 1);
  });

  test("a crash after PayPal accepted the batch resumes to the original batch", async () => {
    const id = bountyId("bountypay/demo", 2);
    insertClaim({ ...claim({ id, repo: "bountypay/demo", issue: 2, pr: 11 }) });
    move(id, "approve", { approvedBy: "maintainer" });
    batches.set((await import("./paypal.ts")).senderBatchId(`${id}@11`), "BATCH-ORIGINAL");
    await ingest(pr(11, 2));
    const b = row(id);
    assert.equal(b.state === "sent" && b.payoutBatchId, "BATCH-ORIGINAL");
  });

  test("a refusal, or a Claude call that fails, holds instead of paying", async () => {
    claudeSays = () => "refuse";
    await ingest(pr(20, 1, null));
    assert.equal(comments.length, 1, "asks for the PayPal line");
    const id = bountyId("bountypay/demo", 4);
    await ingest(pr(14, 4));
    let b = row(id);
    assert.equal(b.state === "held" && b.reason, "refused");
    await reject(id);
    claudeSays = () => "throw";
    await ingest(pr(15, 4));
    b = row(id);
    assert.equal(b.state === "held" && b.reason, "judge_failed");
    assert.equal(batches.size, 0);
  });

  test("a verdict with long reasoning still pays", async () => {
    const id = bountyId("bountypay/demo", 4);
    await reject(id);
    claudeSays = () => ({ ...verdict("pay", 0.95), reasoning: "x".repeat(2000) });
    await ingest(pr(16, 4));
    assert.equal(row(id).state, "sent");
  });

  const sentRow = (issue: number, batchId: string) => {
    const id = bountyId("bountypay/lookup", issue);
    insertClaim(claim({ id, repo: "bountypay/lookup", issue }));
    move(id, "verdictPay", { verdict: verdict("pay", 0.9), approvedBy: "claude" });
    move(id, "payoutSent", { payoutBatchId: batchId });
    return id;
  };

  test("a payout PayPal later fails shows as failed without a webhook", async () => {
    const id = sentRow(1, "B-denied");
    lookups.set("B-denied", () =>
      Response.json({ batch_header: { batch_status: "DENIED" }, items: [{ transaction_status: "FAILED" }] }),
    );
    await checkPendingPayouts();
    const b = row(id);
    assert.equal(b.state === "sent" && b.payoutStatus, "failed");
  });

  test("a failed PayPal lookup leaves the payout pending", async () => {
    const id = sentRow(2, "B-down");
    lookups.set("B-down", () => new Response("upstream down", { status: 503 }));
    await checkPendingPayouts();
    const b = row(id);
    assert.equal(b.state === "sent" && b.payoutStatus, "pending");
  });
});
