import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Cents, Email } from "./bounty.ts";
import { mode } from "./mode.ts";

export type MergedPr = {
  repo: string;
  pr: number;
  prUrl: string;
  title: string;
  body: string;
  issue: number;
  payee: Email | null;
};

/** A merged PR claiming a bounty, either from its merge or from its author's later `PayPal:` comment. */
export type WebhookResult =
  | { kind: "merged"; pr: MergedPr }
  | { kind: "payee_comment"; pr: MergedPr }
  | { kind: "ignored"; reason: string }
  | { kind: "unauthorized" };

export type Fixtures = {
  repo: string;
  maintainers?: string[];
  issues: Record<string, { title: string; body: string; labels: string[] }>;
  /** `offline` is the verdict that stands in for Claude's in offline mode. `comments` are the author's later comments. */
  prs: { number: number; title: string; body: string; diff: string; offline?: unknown; comments?: string[] }[];
};

/** Demo and offline mode read GitHub from demo/fixtures.json and log comments instead of posting them. */
const demo = () => mode() !== "live";

let fixtures: Fixtures | undefined;
export function fixture(): Fixtures {
  fixtures ??= JSON.parse(readFileSync(path.join(process.cwd(), "demo/fixtures.json"), "utf8")) as Fixtures;
  return fixtures;
}

export function parseIssueRef(body: string): number | null {
  const m = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i.exec(body);
  return m ? Number(m[1]) : null;
}

export function parsePayee(body: string): Email | null {
  const m = /^\s*paypal:\s*[<`]?([^\s@<>`]+@[^\s@<>`]+\.[^\s@<>`.]+)[>`]?\.?\s*$/im.exec(body);
  return m ? (m[1] as Email) : null;
}

export function parseBountyLabel(labels: readonly string[]): Cents | null {
  for (const label of labels) {
    const m = /^bounty:\s*\$?(\d{1,6})(?:\.(\d{1,2}))?$/i.exec(label.trim());
    if (m) return (Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"))) as Cents;
  }
  return null;
}

export function sign(raw: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
}

type Signed = Exclude<WebhookResult, { kind: "unauthorized" }>;

export function parseWebhook(raw: string, headers: Headers): WebhookResult {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const got = Buffer.from(headers.get("x-hub-signature-256") ?? "");
  const want = Buffer.from(secret ? sign(raw, secret) : "");
  if (!secret || got.length !== want.length || !timingSafeEqual(got, want)) return { kind: "unauthorized" };

  const payload = JSON.parse(raw);
  const event = headers.get("x-github-event");
  let result: Signed;
  if (event === "pull_request") result = parseMerge(payload);
  else if (event === "issue_comment") result = parsePayeeComment(payload);
  else return { kind: "ignored", reason: "not a pull_request or issue_comment event" };
  if (result.kind !== "ignored" && demo() && !isFixture(result.pr)) {
    return { kind: "ignored", reason: "demo mode accepts only the PRs in demo/fixtures.json" };
  }
  return result;
}

function parseMerge(payload: any): Signed {
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

/** GitHub sends a PR comment as an issue comment whose `issue` is the PR, author and merge time included. */
function parsePayeeComment(payload: any): Signed {
  const { issue: pr, comment } = payload;
  if (payload.action !== "created" || !pr?.pull_request?.merged_at) return { kind: "ignored", reason: "not a new comment on a merged PR" };
  if (comment.user.login !== pr.user.login) return { kind: "ignored", reason: "comment is not from the PR author" };
  const payee = parsePayee(comment.body ?? "");
  if (!payee) return { kind: "ignored", reason: "no PayPal line" };
  const body: string = pr.body ?? "";
  const issue = parseIssueRef(body);
  if (issue === null) return { kind: "ignored", reason: "no closing issue reference" };
  return {
    kind: "payee_comment",
    pr: { repo: payload.repository.full_name, pr: pr.number, prUrl: pr.pull_request.html_url, title: pr.title ?? "", body, issue, payee },
  };
}

/** The public demo pays real sandbox money, so it only judges the PRs, issues and payees it ships with. */
function isFixture(m: MergedPr): boolean {
  const f = fixture();
  return (
    m.repo === f.repo &&
    f.prs.some(
      (p) =>
        p.number === m.pr &&
        parseIssueRef(p.body) === m.issue &&
        [p.body, ...(p.comments ?? [])].map(parsePayee).includes(m.payee),
    )
  );
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

const HANDLE = /^[a-z\d](?:[a-z\d-]{0,38})(?:\/[\w.-]+)?$/i;

/** Keeps the entries that are GitHub user or org/team names, without a leading `@`. */
function handles(list: readonly string[]): string[] {
  return list.map((h) => h.trim().replace(/^@/, "")).filter((h) => HANDLE.test(h));
}

/** The owners on the last `*` line of a CODEOWNERS file: the repo's default reviewers. */
export function defaultOwners(codeowners: string): string[] {
  let owners: string[] = [];
  for (const line of codeowners.split("\n")) {
    const [pattern, ...rest] = line.replace(/#.*/, "").trim().split(/\s+/);
    if (pattern === "*") owners = rest.filter((o) => o.startsWith("@"));
  }
  return handles(owners);
}

/**
 * Who to mention on a held bounty: BOUNTYPAY_MAINTAINERS, else the fixture list in demo mode or the
 * repo's CODEOWNERS default owners in live mode. Empty when none is set. Never throws.
 */
export async function maintainers(repo: string): Promise<string[]> {
  const configured = handles((process.env.BOUNTYPAY_MAINTAINERS ?? "").split(","));
  if (configured.length) return configured;
  if (demo()) return handles(fixture().maintainers ?? []);
  try {
    for (const file of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
      const res = await api(`/repos/${repo}/contents/${file}`, { headers: { Accept: "application/vnd.github.raw+json" } });
      if (res.ok) return defaultOwners(await res.text());
    }
  } catch (e) {
    console.error(`CODEOWNERS lookup failed for ${repo}:`, e);
  }
  return [];
}
