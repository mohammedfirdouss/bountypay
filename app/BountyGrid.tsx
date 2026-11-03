"use client";

import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type CellKeyDownEvent,
  type ColDef,
  type GridApi,
  type ICellRendererParams,
  type IOverlayParams,
  type IRowNode,
  type ModelUpdatedEvent,
  type RowClickedEvent,
  type RowDataUpdatedEvent,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import type { Policy, Row, State } from "@/lib/bounty.ts";
import { BountyPanel, Meter } from "./BountyPanel.tsx";
import { APPROVERS, approverOf, holdReason, holdReasons, PAYPAL, percent, STATES, usd, verdictOf } from "./labels.ts";
import { ReviewButtons, ReviewProvider, useReview, type Notice } from "./Review.tsx";

ModuleRegistry.registerModules([AllCommunityModule]);

type Props = {
  rows: Row[];
  policy: Policy;
  canAct: boolean;
  demo: boolean;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  onRunDemo: () => Promise<void>;
};

type GridContext = { demo: boolean };

const REFRESH_MS = 3000;
const NARROW = "(max-width: 720px)";

const theme = themeQuartz.withParams({
  accentColor: "#047857",
  fontFamily: "inherit",
  fontSize: 14,
  foregroundColor: "#111827",
  headerFontWeight: 600,
  headerBackgroundColor: "#f3f7f5",
  headerTextColor: "#374151",
  borderColor: "#e3e9e6",
  wrapperBorderRadius: 12,
  rowHoverColor: "#f2faf6",
  selectedRowBackgroundColor: "#e3f6ec",
  valueChangeValueHighlightBackgroundColor: "#a7f3d0",
  pinnedRowFontWeight: 600,
  pinnedRowBackgroundColor: "#f3f7f5",
  autoHeightMinBodyHeight: 120,
});

const link = (href: string, text: string, label?: string) => (
  <a href={href} target="_blank" rel="noreferrer" aria-label={label}>
    {text}
  </a>
);

const badge = (value: string, cls: string, title?: string, text = value) => (
  <span className={`badge ${cls}`} title={title}>
    {text}
  </span>
);

const text = ({ value, valueFormatted }: ICellRendererParams<Row>) => <span className="ellipsis">{valueFormatted ?? value}</span>;

const subscribeNarrow = (cb: () => void) => {
  const m = matchMedia(NARROW);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const useNarrow = () => useSyncExternalStore(subscribeNarrow, () => matchMedia(NARROW).matches, () => false);

function Overlay({ overlayType, context }: IOverlayParams<Row, GridContext>) {
  if (overlayType === "noMatchingRows") return <p className="overlay">No bounties match this search or filter.</p>;
  if (overlayType !== "noRows") return null;
  return (
    <p className="overlay">
      {context.demo
        ? "Claude is judging the demo PRs. Rows appear here as each verdict lands."
        : "No bounties yet. Merge a PR that closes an issue labelled bounty:<amount>, and it shows up here."}
    </p>
  );
}

function buildColumns(policy: Policy, narrow: boolean, open: (id: string) => void): ColDef<Row>[] {
  const oneCondition = { maxNumConditions: 1 };
  return [
    {
      headerName: "Bounty",
      field: "id",
      width: 168,
      tooltipField: "id",
      filter: "agTextColumnFilter",
      filterParams: oneCondition,
      cellClass: "cell-flex",
      cellRenderer: ({ data, node }: ICellRendererParams<Row>) =>
        data &&
        (node.rowPinned ? (
          data.id
        ) : (
          <span className="bounty">
            {link(`https://github.com/${data.repo}/issues/${data.issue}`, data.id, `Issue for ${data.id}`)}
            {link(data.prUrl, `PR #${data.pr}`, `Pull request #${data.pr}`)}
          </span>
        )),
    },
    {
      headerName: "PR",
      field: "pr",
      hide: true,
      getQuickFilterText: (p) => `#${p.value}`,
    },
    {
      headerName: "Payee",
      field: "payee",
      width: 130,
      hide: narrow,
      tooltipField: "payee",
      filter: "agTextColumnFilter",
      filterParams: oneCondition,
      cellClass: "cell-flex",
      cellRenderer: text,
    },
    {
      headerName: "Amount",
      field: "amount",
      width: 110,
      type: "rightAligned",
      cellClass: "cell-flex num",
      cellRenderer: text,
      filter: "agNumberColumnFilter",
      filterParams: oneCondition,
      filterValueGetter: (p) => (p.data ? p.data.amount / 100 : null),
      valueFormatter: (p) => (p.value == null ? "" : usd(p.value)),
    },
    {
      headerName: "State",
      field: "state",
      width: 92,
      cellClass: "cell-flex",
      headerTooltip: "sent means PayPal accepted the payout. PayPal status says what happened to the money.",
      getQuickFilterText: (p) => `${p.value} ${STATES[p.value as State]?.hint ?? ""}`,
      cellRenderer: ({ value }: ICellRendererParams<Row, State>) => value && badge(value, `badge-${value}`, STATES[value].hint),
    },
    {
      colId: "approvedBy",
      headerName: "Approved by",
      width: 124,
      hide: narrow,
      cellClass: "cell-flex",
      headerTooltip: "Who released the money. Claude pays on its own only within the mandate. A maintainer can pay anything.",
      valueGetter: (p) => (p.data && approverOf(p.data)) ?? "",
      valueFormatter: (p) => (p.value ? APPROVERS[p.value as keyof typeof APPROVERS].label : ""),
      cellRenderer: ({ value }: ICellRendererParams<Row, "" | keyof typeof APPROVERS>) =>
        value ? badge(value, `badge-by-${value}`, APPROVERS[value].hint, APPROVERS[value].label) : null,
    },
    {
      colId: "reason",
      headerName: "Held because",
      width: 140,
      hide: narrow,
      valueGetter: (p) => (p.data ? holdReasons(p.data).map((r) => holdReason(r, p.data!, policy).short).join(", ") : ""),
      tooltipValueGetter: (p) => (p.data ? holdReasons(p.data).map((r) => holdReason(r, p.data!, policy).long).join(" ") : ""),
      cellClass: "cell-flex reasons-cell",
    },
    {
      colId: "confidence",
      headerName: "Confidence",
      width: 112,
      hide: narrow,
      cellClass: "cell-flex",
      headerTooltip: `Claude's confidence that the PR resolves the issue. The tick marks ${percent(policy.minConfidence)}, the auto-pay threshold.`,
      valueGetter: (p) => (p.data && verdictOf(p.data)?.confidence) ?? null,
      valueFormatter: (p) => (p.value == null ? "" : percent(p.value)),
      cellRenderer: ({ value }: ICellRendererParams<Row, number | null>) =>
        value == null ? null : (
          <span className="confidence">
            <Meter value={value} threshold={policy.minConfidence} />
            <span className="num">{percent(value)}</span>
          </span>
        ),
    },
    {
      colId: "reasoning",
      headerName: "Claude's reasoning",
      flex: 1,
      minWidth: 170,
      hide: narrow,
      cellClass: "cell-flex",
      valueGetter: (p) => (p.data && verdictOf(p.data)?.reasoning) ?? (p.data && "error" in p.data ? p.data.error : ""),
      cellRenderer: ({ value, data, node }: ICellRendererParams<Row, string>) =>
        data && !node.rowPinned ? (
          <span className="preview">
            <span className="preview-text">{value || (data.state === "judging" ? `${STATES.judging.hint}…` : "No verdict")}</span>
            <button className="why" aria-label={`Why? Open details for ${data.id}`} onClick={() => open(data.id)}>
              Why?
            </button>
          </span>
        ) : null,
    },
    {
      colId: "batch",
      headerName: "Payout batch",
      hide: true,
      valueGetter: (p) => (p.data && "payoutBatchId" in p.data ? p.data.payoutBatchId : ""),
    },
    {
      colId: "paypal",
      headerName: "PayPal status",
      width: 130,
      hide: narrow,
      cellClass: "cell-flex",
      headerTooltip: "What PayPal did with the money: succeeded, unclaimed, failed, denied, and so on.",
      valueGetter: (p) => (p.data && "payoutStatus" in p.data ? p.data.payoutStatus : ""),
      cellRenderer: ({ value }: ICellRendererParams<Row, "" | keyof typeof PAYPAL>) =>
        value ? badge(value, `badge-pp-${value}`, PAYPAL[value]) : null,
    },
    { headerName: "Updated", field: "updatedAt", hide: true },
    {
      colId: "actions",
      headerName: "Actions",
      width: 176,
      pinned: narrow ? null : "right",
      sortable: false,
      cellClass: "cell-flex",
      cellRenderer: ({ data, node }: ICellRendererParams<Row>) => (data && !node.rowPinned ? <ReviewButtons row={data} where="grid" /> : null),
    },
  ];
}

const rowClassRules = {
  "row-needs-review": (p: { data?: Row }) => p.data?.state === "held" || p.data?.state === "failed",
};

const sum = (rows: Row[]) => rows.reduce((n, r) => n + r.amount, 0);
const fingerprint = (r: Row) => `${r.state}|${"payoutStatus" in r ? r.payoutStatus : ""}`;
const fromControl = (e: Event | null | undefined) => e?.target instanceof Element && !!e.target.closest("button, a, input");

function useSecondsSince(rows: Row[]) {
  const [updatedAt, setUpdatedAt] = useState(() => Date.now());
  const [now, setNow] = useState(updatedAt);
  useEffect(() => setUpdatedAt(Date.now()), [rows]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.round((now - updatedAt) / 1000));
}

export function BountyGrid({ rows, policy, canAct, demo, onApprove, onReject, onRunDemo }: Props) {
  const router = useRouter();
  const grid = useRef<AgGridReact<Row>>(null);
  const narrow = useNarrow();
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<State | null>(null);
  const stateRef = useRef(stateFilter);
  const [shown, setShown] = useState({ count: 0, amount: 0 });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [position, setPosition] = useState<{ index: number; count: number } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const seen = useRef<Map<string, string> | null>(null);
  const [demoPending, startDemo] = useTransition();
  const age = useSecondsSince(rows);
  const review = useReview(canAct, { approve: onApprove, reject: onReject }, setNotice);

  useEffect(() => {
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [router]);

  useEffect(() => {
    stateRef.current = stateFilter;
    grid.current?.api?.onFilterChanged();
  }, [stateFilter]);

  const open = useCallback((id: string) => {
    setSelectedId((current) => {
      const active = document.activeElement;
      if (current === null) opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      return id;
    });
  }, []);

  const { cancel } = review;
  const close = useCallback(() => {
    const id = selectedId;
    setSelectedId(null);
    cancel();
    requestAnimationFrame(() => {
      const api = grid.current?.api;
      const index = id ? api?.getRowNode(id)?.rowIndex : null;
      if (opener.current?.isConnected && !opener.current.closest(".ag-root")) opener.current.focus();
      else if (api && id && index != null) {
        api.setFocusedCell(index, "id");
        document.querySelector<HTMLElement>(`[row-id="${CSS.escape(id)}"] .ag-cell[col-id="id"]`)?.focus();
      }
      opener.current = null;
    });
  }, [selectedId, cancel]);

  const syncSelection = useCallback((api: GridApi<Row>, id: string | null) => {
    if (!id) {
      api.deselectAll();
      setPosition(null);
      return;
    }
    const node = api.getRowNode(id);
    node?.setSelected(true, true);
    if (node?.displayed && node.rowIndex != null) {
      api.ensureIndexVisible(node.rowIndex);
      const next = { index: node.rowIndex, count: api.getDisplayedRowCount() };
      setPosition((p) => (p?.index === next.index && p.count === next.count ? p : next));
    } else {
      setPosition(null);
    }
  }, []);

  useEffect(() => {
    const api = grid.current?.api;
    if (api) syncSelection(api, selectedId);
  }, [selectedId, syncSelection]);

  const step = useCallback(
    (delta: 1 | -1) => {
      const api = grid.current?.api;
      if (!api || !selectedId) return;
      const index = api.getRowNode(selectedId)?.rowIndex;
      const next = api.getDisplayedRowAtIndex(index == null ? 0 : index + delta);
      if (next?.data) {
        cancel();
        setSelectedId(next.data.id);
      }
    },
    [selectedId, cancel],
  );

  const context = useMemo<GridContext>(() => ({ demo }), [demo]);
  const totals = useMemo(() => [{ id: `${shown.count} shown`, amount: shown.amount }], [shown]);
  const columns = useMemo(() => buildColumns(policy, narrow, open), [policy, narrow, open]);

  const onModelUpdated = useCallback(
    ({ api }: ModelUpdatedEvent<Row>) => {
      let count = 0;
      let amount = 0;
      api.forEachNodeAfterFilter((n) => {
        count++;
        amount += n.data?.amount ?? 0;
      });
      setShown((s) => (s.count === count && s.amount === amount ? s : { count, amount }));
      syncSelection(api, selectedId);
    },
    [selectedId, syncSelection],
  );

  const flashChanges = useCallback(({ api }: RowDataUpdatedEvent<Row>) => {
    const changed: IRowNode<Row>[] = [];
    const next = new Map<string, string>();
    api.forEachNode((n) => {
      if (!n.data) return;
      const f = fingerprint(n.data);
      next.set(n.data.id, f);
      if (seen.current && seen.current.get(n.data.id) !== f) changed.push(n);
    });
    seen.current = next;
    if (changed.length) api.flashCells({ rowNodes: changed, columns: ["state", "approvedBy", "paypal"] });
  }, []);

  const held = rows.filter((r) => r.state === "held");
  const states = Object.keys(STATES) as State[];
  const counts = Object.fromEntries(states.map((s) => [s, rows.filter((r) => r.state === s).length]));
  const selected = selectedId ? rows.find((r) => r.id === selectedId) : undefined;

  return (
    <ReviewProvider value={review}>
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
              All <span className="count">{rows.length}</span>
            </button>
            {states
              .filter((s) => counts[s])
              .map((s) => (
                <button
                  key={s}
                  aria-pressed={stateFilter === s}
                  title={STATES[s].hint}
                  onClick={() => setStateFilter(stateFilter === s ? null : s)}
                >
                  {STATES[s].label} <span className="count">{counts[s]}</span>
                </button>
              ))}
          </div>
          <div className="toolbar-end">
            <span className="live" title={`The grid refreshes every ${REFRESH_MS / 1000} s`}>
              <span className="live-dot" aria-hidden="true" />
              Live · updated {age < 2 ? "just now" : `${age}s ago`}
            </span>
            {demo && canAct && (
              <button
                className="tool"
                disabled={demoPending}
                title="Clears the demo bounties and replays every fixture PR through Claude and PayPal sandbox"
                onClick={() =>
                  startDemo(async () => {
                    try {
                      await onRunDemo();
                      setNotice({ tone: "ok", text: "Replaying the demo PRs. Rows appear as Claude judges each one." });
                    } catch (e) {
                      setNotice({ tone: "error", text: `Couldn't start the demo: ${e instanceof Error ? e.message : String(e)}` });
                    }
                  })
                }
              >
                {demoPending ? "Starting…" : "Replay demo"}
              </button>
            )}
            <button
              className="tool"
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
        </div>

        <div className="notices" aria-live="polite">
          {notice && (
            <p className="notice" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
              <span>{notice.text}</span>
              <button aria-label="Dismiss message" onClick={() => setNotice(null)}>
                ×
              </button>
            </p>
          )}
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
          onModelUpdated={onModelUpdated}
          onRowDataUpdated={flashChanges}
          onRowClicked={(e: RowClickedEvent<Row>) => {
            if (e.data && !e.node.rowPinned && !fromControl(e.event)) open(e.data.id);
          }}
          onCellKeyDown={(e: CellKeyDownEvent<Row>) => {
            const k = e.event as KeyboardEvent | null;
            if (!k || fromControl(k)) return;
            if (k.key === "Enter" && e.data && !e.node.rowPinned) open(e.data.id);
            if (k.key === "Escape" && selectedId) close();
          }}
          rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: false }}
          pinnedBottomRowData={totals}
          rowClassRules={rowClassRules}
          rowHeight={56}
          tooltipShowDelay={300}
          domLayout="autoHeight"
          overlayComponent={Overlay}
        />
        <p className="grid-hint">
          {narrow
            ? "Tap a bounty to read Claude's reasoning and approve or reject it."
            : "Click a row, or press Enter on it, to read Claude's full reasoning."}
        </p>
      </section>
      {selected && (
        <BountyPanel row={selected} policy={policy} position={position} canAct={canAct} modal={narrow} onStep={step} onClose={close} />
      )}
    </ReviewProvider>
  );
}
