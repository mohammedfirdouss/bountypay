"use client";

import { AllCommunityModule, ModuleRegistry, type ColDef, type ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import type { Row } from "@/lib/bounty.ts";

ModuleRegistry.registerModules([AllCommunityModule]);

type Props = {
  rows: Row[];
  canAct: boolean;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
};

const verdictOf = (r: Row) => ("verdict" in r ? r.verdict : null);

function Actions({ data, context }: ICellRendererParams<Row, unknown, Omit<Props, "rows">>) {
  const [pending, start] = useTransition();
  if (!data || !context.canAct) return null;
  const run = (fn: (id: string) => Promise<void>) =>
    start(async () => {
      try {
        await fn(data.id);
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      }
    });
  return (
    <span style={{ display: "flex", gap: 6 }}>
      {data.actions.includes("approve") && (
        <button disabled={pending} onClick={() => run(context.onApprove)}>
          Approve
        </button>
      )}
      {data.actions.includes("reject") && (
        <button disabled={pending} onClick={() => run(context.onReject)}>
          Reject
        </button>
      )}
    </span>
  );
}

const link = (href: string, text: string) => (
  <a href={href} target="_blank" rel="noreferrer">
    {text}
  </a>
);

const columns: ColDef<Row>[] = [
  {
    headerName: "Bounty",
    field: "id",
    cellRenderer: ({ data }: ICellRendererParams<Row>) =>
      data && link(`https://github.com/${data.repo}/issues/${data.issue}`, data.id),
  },
  {
    headerName: "PR",
    field: "pr",
    width: 90,
    cellRenderer: ({ data }: ICellRendererParams<Row>) => data && link(data.prUrl, `#${data.pr}`),
  },
  { headerName: "Payee", field: "payee" },
  { headerName: "Amount", field: "amount", width: 110, valueFormatter: (p) => `$${(p.value / 100).toFixed(2)}` },
  { headerName: "State", field: "state", width: 110 },
  { headerName: "Held because", width: 150, valueGetter: (p) => (p.data && "reason" in p.data ? p.data.reason : "") },
  {
    headerName: "Confidence",
    width: 120,
    valueGetter: (p) => (p.data && verdictOf(p.data)?.confidence) ?? null,
    valueFormatter: (p) => (p.value == null ? "" : `${Math.round(p.value * 100)}%`),
  },
  {
    headerName: "Claude's reasoning",
    flex: 1,
    minWidth: 280,
    wrapText: true,
    autoHeight: true,
    valueGetter: (p) => (p.data && verdictOf(p.data)?.reasoning) ?? (p.data && "error" in p.data ? p.data.error : ""),
  },
  { headerName: "Payout batch", valueGetter: (p) => (p.data && "payoutBatchId" in p.data ? p.data.payoutBatchId : "") },
  { headerName: "PayPal status", width: 130, valueGetter: (p) => (p.data && "payoutStatus" in p.data ? p.data.payoutStatus : "") },
  { headerName: "Updated", field: "updatedAt", valueFormatter: (p) => new Date(p.value).toLocaleString() },
  { headerName: "Actions", width: 180, sortable: false, cellRenderer: Actions },
];

export function BountyGrid({ rows, ...context }: Props) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [router]);

  return (
    <AgGridReact<Row>
      rowData={rows}
      columnDefs={columns}
      context={context}
      getRowId={(p) => p.data.id}
      domLayout="autoHeight"
      overlayNoRowsTemplate="No bounties yet. Merge a PR that closes a bounty:<usd> issue, or run the demo script."
    />
  );
}
