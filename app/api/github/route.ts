import { after } from "next/server";
import { ingest } from "@/lib/bounty.ts";
import { parseMergeWebhook } from "@/lib/github.ts";

export async function POST(req: Request) {
  const event = parseMergeWebhook(await req.text(), req.headers);
  if (event.kind === "unauthorized") return new Response("bad signature", { status: 401 });
  if (event.kind === "ignored") return Response.json({ ignored: event.reason });
  // Claude can outlast GitHub's 10 s delivery timeout, so answer first and judge after.
  after(() => ingest(event.pr).catch((e) => console.error(`ingest ${event.pr.repo}#${event.pr.issue}:`, e)));
  return Response.json({ accepted: true }, { status: 202 });
}
