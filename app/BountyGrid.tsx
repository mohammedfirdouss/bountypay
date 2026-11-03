"use client";

import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type ICellRendererParams,
  type IRowNode,
  type ModelUpdatedEvent,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { Row, State } from "@/lib/bounty.ts";

ModuleRegistry.registerModules([AllCommunityModule]);

type Props = {
  rows: Row[];
  canAct: boolean;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
};

const STATES: State[] = ["held", "judging", "paying", "sent", "failed", "rejected"];

const theme = themeQuartz.withParams({
  accentColor: "#0070e0",
  fontFamily: "inherit",
  fontSize: 14,
  headerFontWeight: 600,
  headerBackgroundColor: "#f6f8fb",
  wrapperBorderRadius: 10,
  pinnedRowFontWeight: 600,
  pinnedRowBackgroundColor: "#f6f8fb",
  autoHeightMinBodyHeight: 84,
});

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

const verdictOf = (r: Row) => ("verdict" in r ? r.verdict : null);

const badge = (value: string | null | undefined, prefix = "") =>
  value ? <span className={`badge badge-${prefix}${value}`}>{value}</span> : null;

const link = (href: string, text: string) => (
  <a href={href} target="_blank" rel="noreferrer">
    {text}
  </a>
);

function Actions({ data, node, context }: ICellRendererParams<Row, unknown, Omit<Props, "rows">>) {
  const [pending, start] = useTransition();
  if (!data || node.rowPinned || !context.canAct) return null;
  const run = (fn: (id: string) => Promise<void>) =>
    start(async () => {
      try {
        await fn(data.id);
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      }
    });
  return (
    <span className="actions">
      {data.actions.includes("approve") && (
        <button className="primary" disabled={pending} onClick={() => run(context.onApprove)}>
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

function Confidence({ value }: ICellRendererParams<Row, number | null>) {
  if (value == null) return null;
  const pct = Math.round(value * 100);
  return (
    <span className="confidence">
      <span className="confidence-bar">
        <span style={{ width: `${pct}%` }} />
      </span>
      {pct}%
    </span>
  );
}

const oneCondition = { maxNumConditions: 1 };

const columns: ColDef<Row>[] = [
  {
    headerName: "Bounty",
    field: "id",
    width: 170,
    tooltipField: "id",
    filter: "agTextColumnFilter",
    filterParams: oneCondition,
    cellRenderer: ({ data, node }: ICellRendererParams<Row>) =>
      data && (node.rowPinned ? data.id : link(`https://github.com/${data.repo}/issues/${data.issue}`, data.id)),
  },
  {
    headerName: "PR",
    field: "pr",
    width: 64,
    getQuickFilterText: (p) => `#${p.value}`,
    cellRenderer: ({ data, node }: ICellRendererParams<Row>) => data && !node.rowPinned && link(data.prUrl, `#${data.pr}`),
  },
  {
    headerName: "Payee",
    field: "payee",
    width: 150,
    tooltipField: "payee",
    filter: "agTextColumnFilter",
    filterParams: oneCondition,
  },
  {
    headerName: "Amount",
    field: "amount",
    width: 115,
    type: "rightAligned",
    filter: "agNumberColumnFilter",
    filterParams: oneCondition,
    filterValueGetter: (p) => (p.data ? p.data.amount / 100 : null),
    valueFormatter: (p) => (p.value == null ? "" : usd(p.value)),
  },
  {
    headerName: "State",
    field: "state",
    width: 95,
    headerTooltip: "sent means PayPal accepted the payout. PayPal status says what happened to the money.",
    cellRenderer: (p: ICellRendererParams<Row, string>) => badge(p.value),
  },
  {
    colId: "reason",
    headerName: "Held because",
    width: 165,
    valueGetter: (p) => (p.data && "reasons" in p.data ? p.data.reasons.map((r) => r.replaceAll("_", " ")).join(", ") : ""),
    valueFormatter: (p) => p.value.replaceAll("_", " "),
  },
  {
    colId: "confidence",
    headerName: "Confidence",
    width: 140,
    valueGetter: (p) => (p.data && verdictOf(p.data)?.confidence) ?? null,
    valueFormatter: (p) => (p.value == null ? "" : `${Math.round(p.value * 100)}%`),
    cellRenderer: Confidence,
  },
  {
    colId: "reasoning",
    headerName: "Claude's reasoning",
    flex: 1,
    minWidth: 240,
    cellClass: "reasoning",
    valueGetter: (p) => (p.data && verdictOf(p.data)?.reasoning) ?? (p.data && "error" in p.data ? p.data.error : ""),
    tooltipValueGetter: (p) => p.value,
    cellRenderer: (p: ICellRendererParams<Row, string>) => <span className="clamp">{p.value}</span>,
  },
  { colId: "batch", headerName: "Payout batch", hide: true, valueGetter: (p) => (p.data && "payoutBatchId" in p.data ? p.data.payoutBatchId : "") },
  {
    colId: "paypal",
    headerName: "PayPal status",
    width: 135,
    headerTooltip: "What PayPal did with the money: succeeded, unclaimed, failed, denied, and so on.",
    valueGetter: (p) => (p.data && "payoutStatus" in p.data ? p.data.payoutStatus : ""),
    cellRenderer: (p: ICellRendererParams<Row, string>) => badge(p.value, "pp-"),
  },
  {
    headerName: "Updated",
    field: "updatedAt",
    hide: true,
  },
  { colId: "actions", headerName: "Actions", width: 160, pinned: "right", sortable: false, cellRenderer: Actions },
];

const rowClassRules = {
  "row-needs-review": (p: { data?: Row }) => p.data?.state === "held" || p.data?.state === "failed",
};

const sum = (rows: Row[]) => rows.reduce((n, r) => n + r.amount, 0);

export function BountyGrid({ rows, ...context }: Props) {
  const router = useRouter();
  const grid = useRef<AgGridReact<Row>>(null);
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<State | null>(null);
  const stateRef = useRef(stateFilter);
  const [shown, setShown] = useState({ count: 0, amount: 0 });

  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [router]);

  useEffect(() => {
    stateRef.current = stateFilter;
    grid.current?.api?.onFilterChanged();
  }, [stateFilter]);

  const recount = useCallback(({ api }: ModelUpdatedEvent<Row>) => {
    let count = 0;
    let amount = 0;
    api.forEachNodeAfterFilter((n) => {
      count++;
      amount += n.data?.amount ?? 0;
    });
    setShown((s) => (s.count === count && s.amount === amount ? s : { count, amount }));
  }, []);

  const held = rows.filter((r) => r.state === "held");
  const counts = Object.fromEntries(STATES.map((s) => [s, rows.filter((r) => r.state === s).length]));

  return (
    <section className="board">
      <dl className="summary">
        <div>
          <dt>Paid out</dt>
          <dd>{usd(sum(rows.filter((r) => r.state === "sent" && r.payoutStatus === "succeeded")))}</dd>
        </div>
        <div className={held.length ? "attention" : undefined}>
          <dt>Held for review</dt>
          <dd>
            {held.length} <small>· {usd(sum(held))}</small>
          </dd>
        </div>
        <div>
          <dt>Bounties</dt>
          <dd>{rows.length}</dd>
        </div>
      </dl>

      <div className="toolbar">
        <input
          type="search"
          placeholder="Search bounty, payee, PR, state, reasoning…"
          aria-label="Search bounties"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="chips" role="group" aria-label="Filter by state">
          <button aria-pressed={stateFilter === null} onClick={() => setStateFilter(null)}>
            All {rows.length}
          </button>
          {STATES.filter((s) => counts[s]).map((s) => (
            <button key={s} aria-pressed={stateFilter === s} onClick={() => setStateFilter(stateFilter === s ? null : s)}>
              {s} {counts[s]}
            </button>
          ))}
        </div>
        <button
          className="export"
          onClick={() =>
            grid.current?.api.exportDataAsCsv({
              fileName: "bountypay.csv",
              skipPinnedBottom: true,
              columnKeys: grid.current.api.getColumns()?.filter((c) => c.getColId() !== "actions"),
            })
          }
        >
          Export CSV
        </button>
      </div>

      <AgGridReact<Row>
        ref={grid}
        theme={theme}
        rowData={rows}
        columnDefs={columns}
        context={context}
        getRowId={(p) => (p.rowPinned ? "total" : p.data.id)}
        quickFilterText={search}
        isExternalFilterPresent={() => stateRef.current !== null}
        doesExternalFilterPass={(n: IRowNode<Row>) => n.data?.state === stateRef.current}
        onGridReady={(e) => e.api.setGridOption("popupParent", document.body)}
        onModelUpdated={recount}
        pinnedBottomRowData={[{ id: `${shown.count} shown`, amount: shown.amount }]}
        rowClassRules={rowClassRules}
        rowHeight={52}
        tooltipShowDelay={300}
        domLayout="autoHeight"
        overlayNoRowsTemplate="No bounties yet. Merge a PR that closes a bounty:<usd> issue, or run the demo script."
      />
    </section>
  );
}
