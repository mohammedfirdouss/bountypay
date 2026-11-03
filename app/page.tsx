import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { after, connection } from "next/server";
import { Suspense } from "react";
import { approve, checkPendingPayouts, listBounties, POLICY, reject } from "@/lib/bounty.ts";
import { ensureDemoSeeded, runDemo } from "@/lib/demo.ts";
import { BountyGrid } from "./BountyGrid.tsx";

const COOKIE = "bountypay_token";

async function authorized(): Promise<boolean> {
  const token = process.env.DASHBOARD_TOKEN;
  return !token || (await cookies()).get(COOKIE)?.value === token;
}

async function onApprove(id: string) {
  "use server";
  if (!(await authorized())) throw new Error("Enter the dashboard token first.");
  await approve(id);
  refresh();
}

async function onReject(id: string) {
  "use server";
  if (!(await authorized())) throw new Error("Enter the dashboard token first.");
  await reject(id);
  refresh();
}

const demo = () => process.env.BOUNTYPAY_DEMO === "1";

async function onRunDemo() {
  "use server";
  if (!(await authorized())) throw new Error("Enter the dashboard token first.");
  if (!demo()) throw new Error("The demo only runs with BOUNTYPAY_DEMO=1.");
  after(() => runDemo().catch((e) => console.error("demo replay failed:", e)));
  refresh();
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
