import assert from "node:assert/strict";
import { test } from "node:test";

process.env.BOUNTYPAY_DB = ":memory:";
process.env.BOUNTYPAY_DEMO = "offline";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;

const fetched: string[] = [];
globalThis.fetch = async (input) => {
  fetched.push(String(input));
  throw new Error(`offline mode fetched ${input}`);
};
const comments: string[] = [];
console.log = (...args: unknown[]) => void comments.push(String(args[0]));

const { checkPendingPayouts, listBounties } = await import("./bounty.ts");
const { runDemo } = await import("./demo.ts");
const { mode } = await import("./mode.ts");

test("offline mode runs the whole demo with no keys and no network", async () => {
  assert.equal(mode(), "offline");
  await runDemo();
  await checkPendingPayouts();
  const rows = Object.fromEntries(listBounties().map((b) => [b.id, b]));
  const summary = (id: string) => {
    const b = rows[`bountypay/demo#${id}`];
    if (b.state === "sent") return { state: b.state, pr: b.pr, batch: b.payoutBatchId.slice(0, 8), status: b.payoutStatus };
    if (b.state === "held") return { state: b.state, pr: b.pr, reasons: b.reasons };
    return { state: b.state, pr: b.pr };
  };
  assert.deepEqual(
    ["1", "2", "3", "5"].map(summary),
    [
      { state: "sent", pr: 10, batch: "OFFLINE-", status: "succeeded" },
      { state: "held", pr: 11, reasons: ["judged_unresolved", "low_confidence"] },
      { state: "held", pr: 12, reasons: ["over_cap"] },
      { state: "held", pr: 15, reasons: ["judged_unresolved", "low_confidence"] },
    ],
  );
  assert.ok(comments.some((c) => c.includes("bountypay/demo#13") && c.includes("already claimed by #10")));
  assert.deepEqual(fetched, [], "nothing reached Anthropic, PayPal or GitHub");
});
