import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { Suspense } from "react";
import { approve, listBounties, POLICY, reject } from "@/lib/bounty.ts";
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

async function unlock(form: FormData) {
  "use server";
  (await cookies()).set(COOKIE, String(form.get("token") ?? ""), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  refresh();
}

export default function Page() {
  return (
    <main>
      <header>
        <h1>BountyPay</h1>
        <p>
          Claude pays a merged bounty PR through PayPal when it is at least {POLICY.minConfidence * 100}% sure the diff
          resolves the issue and the bounty is at most ${POLICY.cap / 100}. Everything else waits here for a maintainer.
        </p>
      </header>
      <Suspense fallback={<p>Loading bounties…</p>}>
        <Dashboard />
      </Suspense>
    </main>
  );
}

async function Dashboard() {
  await connection();
  const canAct = await authorized();
  return (
    <>
      {!canAct && (
        <form action={unlock}>
          <input name="token" type="password" placeholder="Dashboard token" aria-label="Dashboard token" />{" "}
          <button type="submit">Unlock Approve and Reject</button>
        </form>
      )}
      <BountyGrid rows={listBounties()} canAct={canAct} onApprove={onApprove} onReject={onReject} />
    </>
  );
}
