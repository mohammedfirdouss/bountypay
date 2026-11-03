import { recordPayoutStatus } from "@/lib/bounty.ts";
import { parsePayoutWebhook } from "@/lib/paypal.ts";

export async function POST(req: Request) {
  const event = await parsePayoutWebhook(await req.text(), req.headers);
  if (event.kind === "unauthorized") return new Response("bad signature", { status: 400 });
  if (event.kind === "status") recordPayoutStatus(event.batchId, event.status, event.at, "webhook");
  return new Response(null, { status: 200 });
}
