import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Cents, Email } from "./bounty.ts";

export type MergedPr = {
  repo: string;
  pr: number;
  prUrl: string;
  title: string;
  body: string;
  issue: number;
  payee: Email | null;
};

export type WebhookResult =
  | { kind: "merged"; pr: MergedPr }
  | { kind: "ignored"; reason: string }
  | { kind: "unauthorized" };

export type Fixtures = {
  repo: string;
  issues: Record<string, { title: string; body: string; labels: string[] }>;
  prs: { number: number; title: string; body: string; diff: string }[];
};

const demo = () => process.env.BOUNTYPAY_DEMO === "1";

let fixtures: Fixtures | undefined;
function fixture(): Fixtures {
  fixtures ??= JSON.parse(readFileSync(path.join(process.cwd(), "demo/fixtures.json"), "utf8")) as Fixtures;
  return fixtures;
}

export function parseIssueRef(body: string): number | null {
  const m = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i.exec(body);
  return m ? Number(m[1]) : null;
}

export function parsePayee(body: string): Email | null {
  const m = /^\s*paypal:\s*([^\s@]+@[^\s@]+\.[^\s@]+)\s*$/im.exec(body);
  return m ? (m[1] as Email) : null;
}

export function parseBountyLabel(labels: readonly string[]): Cents | null {
  for (const label of labels) {
    const m = /^bounty:(\d{1,6})(?:\.(\d{1,2}))?$/i.exec(label.trim());
    if (m) return (Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"))) as Cents;
  }
  return null;
}

export function sign(raw: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
}

export function parseMergeWebhook(raw: string, headers: Headers): WebhookResult {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const got = Buffer.from(headers.get("x-hub-signature-256") ?? "");
  const want = Buffer.from(secret ? sign(raw, secret) : "");
  if (!secret || got.length !== want.length || !timingSafeEqual(got, want)) return { kind: "unauthorized" };

  if (headers.get("x-github-event") !== "pull_request") return { kind: "ignored", reason: "not a pull_request event" };
  const payload = JSON.parse(raw);
  const pr = payload.pull_request;
  if (payload.action !== "closed" || pr?.merged !== true) return { kind: "ignored", reason: "not a merge" };
  const body: string = pr.body ?? "";
  const issue = parseIssueRef(body);
  if (issue === null) return { kind: "ignored", reason: "no closing issue reference" };
  return {
    kind: "merged",
    pr: {
      repo: payload.repository.full_name,
      pr: pr.number,
      prUrl: pr.html_url,
      title: pr.title ?? "",
      body,
      issue,
      payee: parsePayee(body),
    },
  };
}

async function api(route: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`https://api.github.com${route}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
  if (!res.ok && res.status !== 404) throw new Error(`GitHub ${route}: ${res.status}`);
  return res;
}

export async function fetchBountyIssue(
  repo: string,
  issue: number,
): Promise<{ title: string; body: string; amount: Cents } | null> {
  let found: { title: string; body: string; labels: string[] } | undefined;
  if (demo()) {
    found = repo === fixture().repo ? fixture().issues[issue] : undefined;
  } else {
    const res = await api(`/repos/${repo}/issues/${issue}`);
    if (res.status === 404) return null;
    const json = await res.json();
    found = {
      title: json.title,
      body: json.body ?? "",
      labels: json.labels.map((l: string | { name: string }) => (typeof l === "string" ? l : l.name)),
    };
  }
  if (!found) return null;
  const amount = parseBountyLabel(found.labels);
  return amount === null ? null : { title: found.title, body: found.body, amount };
}

export async function fetchDiff(repo: string, pr: number): Promise<string> {
  if (demo()) return fixture().prs.find((p) => p.number === pr)?.diff ?? "";
  return (await api(`/repos/${repo}/pulls/${pr}`, { headers: { Accept: "application/vnd.github.diff" } })).text();
}

export async function comment(repo: string, issueOrPr: number, body: string): Promise<void> {
  if (demo()) {
    console.log(`[demo comment] ${repo}#${issueOrPr}: ${body}`);
    return;
  }
  await api(`/repos/${repo}/issues/${issueOrPr}/comments`, { method: "POST", body: JSON.stringify({ body }) });
}
