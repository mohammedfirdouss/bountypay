import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { after, connection } from "next/server";
import { Suspense } from "react";
import { approve, checkPendingPayouts, listBounties, POLICY, reject } from "@/lib/bounty.ts";
import { ensureDemoSeeded, runDemo } from "@/lib/demo.ts";
import { mode } from "@/lib/mode.ts";
import { BountyGrid } from "./BountyGrid.tsx";
import type { Outcome } from "./Review.tsx";

const COOKIE = "bountypay_token";

async function authorized(): Promise<boolean> {
  const token = process.env.DASHBOARD_TOKEN;
  return !token || (await cookies()).get(COOKIE)?.value === token;
}

const OK: Outcome = { ok: true };
const LOCKED: Outcome = { ok: false, message: "Enter the dashboard token first." };
const GONE: Outcome = { ok: false, message: "This bounty no longer exists. A demo replay may have cleared it." };

const exists = (id: string) => listBounties().some((r) => r.id === id);

async function onApprove(id: string): Promise<Outcome> {
  "use server";
  refresh();
  if (!(await authorized())) return LOCKED;
  if (!exists(id)) return GONE;
  const b = await approve(id);
  if (b.state === "failed") return { ok: false, message: `PayPal did not take the payout (${b.error}). Approve again to retry; it never pays twice.` };
  if (b.state === "rejected") return { ok: false, message: "A maintainer already rejected it." };
  return OK;
}

async function onReject(id: string): Promise<Outcome> {
  "use server";
  refresh();
  if (!(await authorized())) return LOCKED;
  if (!exists(id)) return GONE;
  const b = await reject(id);
  if (b.state === "sent") return { ok: false, message: "PayPal already accepted the payout, so it can no longer be rejected." };
  return OK;
}

const demo = () => mode() !== "live";

async function onRunDemo(): Promise<Outcome> {
  "use server";
  refresh();
  if (!(await authorized())) return LOCKED;
  if (!demo()) return { ok: false, message: "The demo only runs in demo or offline mode." };
  after(() => runDemo().catch((e) => console.error("demo replay failed:", e)));
  return OK;
}

async function unlock(form: FormData) {
  "use server";
  (await cookies()).set(COOKIE, String(form.get("token") ?? ""), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  refresh();
}

const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export default function Page() {
  return (
    <main>
      <header className="masthead">
        <div className="brand">
          <svg className="mark" viewBox="0 0 64 64" aria-hidden="true">
            <rect width="64" height="64" rx="16" fill="#064e3b" />
            <path d="M8 44 Q32 10 56 44" stroke="#6ee7b7" strokeWidth="5" fill="none" strokeLinecap="round" />
            <path d="M6 46h52" stroke="#6ee7b7" strokeWidth="4" strokeLinecap="round" />
            <path d="M18 32v14M32 26v20M46 32v14" stroke="#6ee7b7" strokeWidth="2.5" strokeLinecap="round" opacity=".7" />
            <circle cx="32" cy="22" r="7" fill="#fbbf24" />
            <path d="M6 53c6 3 10 3 16 0s10-3 16 0 10 3 16 0" stroke="#34d399" strokeWidth="2.5" fill="none" strokeLinecap="round" opacity=".6" />
          </svg>
          <div>
            <h1>
              BountyPay <span className="pill pill-sandbox">Sandbox</span>
              <Suspense>
                <OfflinePill />
              </Suspense>
            </h1>
            <p className="tagline">Open-source bounties, paid through PayPal once Claude checks the merged PR.</p>
          </div>
        </div>
        <div className="masthead-side">
          <Suspense fallback={<div className="access" />}>
            <Access />
          </Suspense>
          <p className="powered">Powered by Claude · PayPal Payouts · AG Grid</p>
        </div>
      </header>
      <ul className="mandate">
        <li>
          <strong>Claude pays at ≥ {POLICY.minConfidence * 100}% confidence</strong>
          <span>that the merged PR resolves the issue</span>
        </li>
        <li>
          <strong>Up to {usd(POLICY.cap)} per bounty</strong>
          <span>larger bounties always go to a maintainer</span>
        </li>
        <li>
          <strong>Everything else waits for you</strong>
          <span>held rows are highlighted below</span>
        </li>
      </ul>
      <Suspense fallback={<p>Loading bounties…</p>}>
        <Dashboard />
      </Suspense>
    </main>
  );
}

async function OfflinePill() {
  await connection();
  if (mode() !== "offline") return null;
  return (
    <span className="pill pill-offline" title="Built-in stand-ins replace Claude and PayPal, so no keys are needed">
      Offline
    </span>
  );
}

function Lock({ open }: { open: boolean }) {
  return (
    <svg className="lock" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7.5" rx="1.8" fill="currentColor" />
      <path d={open ? "M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" : "M5.5 7V5a2.5 2.5 0 0 1 5 0v2"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

async function Access() {
  await connection();
  if (await authorized()) {
    return (
      <p className="access access-open" role="status">
        <Lock open /> Approve and Reject unlocked
      </p>
    );
  }
  return (
    <form action={unlock} className="access">
      <label className="access-field">
        <Lock open={false} />
        <input name="token" type="password" placeholder="Dashboard token" aria-label="Dashboard token" />
      </label>
      <button type="submit" title="Unlock Approve and Reject">Unlock</button>
    </form>
  );
}

async function Dashboard() {
  await connection();
  const canAct = await authorized();
  ensureDemoSeeded();
  await checkPendingPayouts();
  return (
    <BountyGrid
      rows={listBounties()}
      policy={POLICY}
      canAct={canAct}
      demo={demo()}
      onApprove={onApprove}
      onReject={onReject}
      onRunDemo={onRunDemo}
    />
  );
}
