import { after } from "next/server";
import { ingest, ingestComment } from "@/lib/bounty.ts";
import { parseWebhook } from "@/lib/github.ts";
import { mode } from "@/lib/mode.ts";

const DEMO_INGESTS_PER_HOUR = 30;
const recentIngests: number[] = [];

/** Judges can hold the demo's webhook secret, so cap how many Claude and PayPal runs it can start. */
function demoRateLimited(): boolean {
  if (mode() !== "demo") return false;
  const now = Date.now();
  while (recentIngests.length && now - recentIngests[0] >= 3_600_000) recentIngests.shift();
  if (recentIngests.length >= DEMO_INGESTS_PER_HOUR) return true;
  recentIngests.push(now);
  return false;
}

export async function POST(req: Request) {
  const event = parseWebhook(await req.text(), req.headers);
  if (event.kind === "unauthorized") return new Response("bad signature", { status: 401 });
  if (event.kind === "ignored") return Response.json({ ignored: event.reason });
  if (demoRateLimited()) return Response.json({ error: "demo rate limit reached, try again later" }, { status: 429 });
  // Claude can outlast GitHub's 10 s delivery timeout, so answer first and judge after.
  const claim = event.kind === "merged" ? ingest : ingestComment;
  after(() => claim(event.pr).catch((e) => console.error(`ingest ${event.pr.repo}#${event.pr.issue}:`, e)));
  return Response.json({ accepted: true }, { status: 202 });
}
