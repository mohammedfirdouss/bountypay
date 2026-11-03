import { clearBounties, ingest, listBounties } from "./bounty.ts";
import { fixture, parseIssueRef, parsePayee } from "./github.ts";
import { mode } from "./mode.ts";

const demo = () => mode() !== "live";

let running: Promise<void> | undefined;

/**
 * Clears the demo store and replays every fixture PR, then the first one again, through the webhook's
 * ingest path, one at a time, so the configured Claude and PayPal backends run. A call made while a
 * replay runs joins it instead of starting another. Rejects in live mode without touching anything.
 */
export function runDemo(): Promise<void> {
  if (!demo()) return Promise.reject(new Error("runDemo needs BOUNTYPAY_DEMO=1 or offline"));
  running ??= replay().finally(() => {
    running = undefined;
  });
  return running;
}

/** In demo or offline mode, starts a replay in the background when the store is empty. Never throws. */
export function ensureDemoSeeded(): void {
  if (!demo() || running || listBounties().length > 0) return;
  runDemo().catch((e) => console.error("demo replay failed:", e));
}

async function replay(): Promise<void> {
  clearBounties();
  const { repo, prs } = fixture();
  for (const p of [...prs, prs[0]]) {
    const issue = parseIssueRef(p.body);
    if (issue === null) continue;
    const merge = {
      repo,
      pr: p.number,
      prUrl: `https://github.com/${repo}/pull/${p.number}`,
      title: p.title,
      body: p.body,
      issue,
      payee: parsePayee(p.body),
    };
    await ingest(merge).catch((e) => console.error(`demo ingest ${repo}#${issue}:`, e));
  }
}
