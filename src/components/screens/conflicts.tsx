"use client";
// Conflicts (frontend.md §3.9): rows from committed imports that couldn't be placed as written. Filter by type /
// berth / status, place each one on a berth (optionally on other days), or dismiss one or a whole type at once.
import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Sparkles, X } from "lucide-react";
import { CONFLICT_TYPES, type Conflict, type ConflictStatus, type ConflictType, type Id, type ResolveConflictInput, type SolveResult } from "@shared/contract";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiRequestError, errorMessage } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { formatRange, isISODate } from "@/lib/dates";
import { ft, occupantLabel, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { OccupantIcon } from "@/components/booking/occupant";
import { useBookingEditor } from "@/components/booking/booking-editor";
import { useProjectCtx } from "@/components/project/project-context";
import { DEFAULT_SOLVE_OPTIONS, ProposalReview, SolveOptionsPopover, describeOptions, type SolveSettings } from "./auto-resolve";
import { ErrorBox, PageHeader } from "./page-header";

/** Ticked conflicts: id → type, so a bulk dismiss of one type can drop exactly those ticks. */
type Selection = Map<Id, ConflictType>;
const MAX_SOLVE = 1000;   // SolveRequestSchema: conflictIds max

export const CONFLICT_LABEL: Record<ConflictType, { name: string; help: string }> = {
  OVERLAP: { name: "Berth taken", help: "Another booking already holds the berth on some of these days." },
  VESSEL_TOO_LONG: { name: "Too long", help: "The vessel is longer than the berth." },
  VESSEL_DOUBLE_BERTHED: { name: "Vessel elsewhere", help: "The same vessel is already at another berth on some of these days." },
  NO_BERTH: { name: "No berth", help: "The row had no berth, or named one this project doesn't have." },
  BERTH_INACTIVE: { name: "Berth off", help: "The berth exists but is switched off." },
};
const STATUSES: { id: ConflictStatus; label: string }[] = [
  { id: "open", label: "Open" }, { id: "placed", label: "Placed" }, { id: "dismissed", label: "Dismissed" },
];

export function ConflictsScreen() {
  const { pid, api } = useProjectCtx();
  const router = useRouter(), pathname = usePathname(), params = useSearchParams();
  const type = (params.get("type") as ConflictType | null) ?? undefined;
  const status = (params.get("status") as ConflictStatus | null) ?? "open";
  const berthId = params.get("berth") ?? undefined;
  const [q, setQ] = useState("");
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  };

  const summary = useQuery({ queryKey: qk.conflictSummary(pid), queryFn: () => api.conflictSummary() });
  const filter = { type, status, berthId, q: q.trim() || undefined };
  const list = useInfiniteQuery({
    queryKey: qk.conflicts(pid, filter),
    queryFn: ({ pageParam }) => api.listConflicts({ ...filter, cursor: pageParam ?? undefined, limit: 25 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,   // switching filters keeps the old rows on screen instead of a blank list
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const s = summary.data;
  const [bulk, setBulk] = useState(false);
  const refresh = useRefresh();

  // ── auto-resolve: tick conflicts → Solve → review proposals → Apply ──
  const [picked, setPicked] = useState<Selection>(new Map());
  const [opts, setOpts] = useState<SolveSettings>(DEFAULT_SOLVE_OPTIONS);
  const [review, setReview] = useState<{ result: SolveResult; run: number } | null>(null);
  const [selectingAll, setSelectingAll] = useState(false);
  const canSelect = status === "open";
  const sel: Selection = canSelect ? picked : new Map();
  const filtered = !!(type || berthId || q.trim());
  const editSel = (fn: (m: Selection) => void) => setPicked((prev) => { const next = new Map(prev); fn(next); return next; });
  const shownAll = items.length > 0 && items.every((c) => sel.has(c.id));
  const shownSome = items.some((c) => sel.has(c.id));
  const matching = type ? s?.byType[type] : berthId ? s?.byBerth.find((b) => b.berthId === berthId)?.open : q.trim() ? undefined : s?.open;
  const everything = !filtered && s != null && sel.size === s.open;   // every open conflict: send "all", not 1,000+ ids
  const tooMany = !everything && sel.size > MAX_SOLVE;

  const solve = useMutation({
    mutationFn: () => api.solveConflicts({ conflictIds: everything ? "all" : [...sel.keys()], options: opts }),
    onSuccess: (result) => setReview({ result, run: Date.now() }),
  });

  /** "Select all N that match": the list is paged, so walk the remaining pages (200 at a time) and tick them all. */
  const selectAllMatching = async () => {
    setSelectingAll(true);
    try {
      const found: Conflict[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.listConflicts({ ...filter, cursor, limit: 200 });
        found.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      editSel((m) => { for (const c of found) m.set(c.id, c.type); });
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSelectingAll(false); }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-3 sm:p-5">
      <PageHeader title="Conflicts"
        sub="Rows from your uploads that read fine but couldn't be placed as written. Place each on a berth, dismiss it, or tick several and let Auto-resolve propose berths. Nothing here is on the schedule yet." />

      {/* totals by status */}
      <div className="grid grid-cols-3 divide-x rounded-xl border bg-surface">
        {STATUSES.map((st) => (
          <button key={st.id} type="button" onClick={() => setParam("status", st.id === "open" ? null : st.id)}
            className={cn("px-4 py-3 text-left hover:bg-accent", status === st.id && "bg-harbor-soft")}>
            <p className={cn("num text-2xl font-semibold tracking-tight", st.id === "open" && (s?.open ?? 0) > 0 && "text-signal")}>
              {s ? s[st.id].toLocaleString() : "…"}
            </p>
            <p className="text-xs text-ink-muted">{st.label.toLowerCase()}</p>
          </button>
        ))}
      </div>

      {/* filters: type chips (open counts), berth, search */}
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={!type} onClick={() => setParam("type", null)}>All types</Chip>
        {CONFLICT_TYPES.map((t) => (
          <Chip key={t} active={type === t} onClick={() => setParam("type", type === t ? null : t)} title={CONFLICT_LABEL[t].help}>
            {CONFLICT_LABEL[t].name}{s && <span className="num ml-1.5 opacity-70">{s.byType[t]}</span>}
          </Chip>
        ))}
        <select aria-label="Filter by berth" value={berthId ?? ""} onChange={(e) => setParam("berth", e.target.value || null)}
          className="h-8 rounded-lg border border-input bg-surface px-2 text-sm">
          <option value="">All berths</option>
          {s?.byBerth.filter((b) => b.berthId).map((b) => <option key={b.berthId} value={b.berthId!}>{b.berthName} ({b.open})</option>)}
        </select>
        <Input aria-label="Search" placeholder="Search vessel or title" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 w-48" />
        {status === "open" && type && (s?.byType[type] ?? 0) > 0 && (
          <Button variant="ghost" size="sm" className="ml-auto text-signal" onClick={() => setBulk(true)}>
            Dismiss all {plural(s!.byType[type], CONFLICT_LABEL[type].name.toLowerCase())}…
          </Button>
        )}
      </div>

      {list.error ? <ErrorBox message={errorMessage(list.error)} onRetry={() => list.refetch()} /> :
       list.isLoading ? <div className="h-40 animate-pulse rounded-xl bg-muted" /> :
       items.length === 0 ? <Empty status={status} filtered={!!(type || berthId || q.trim())} total={s?.open ?? 0} /> : (
        <>
          {canSelect && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-surface px-3 py-2 text-sm">
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox checked={shownAll} indeterminate={shownSome && !shownAll}
                  onChange={() => editSel((m) => { for (const c of items) { if (shownAll) m.delete(c.id); else m.set(c.id, c.type); } })} />
                Select all {items.length.toLocaleString()} shown
              </label>
              {shownAll && list.hasNextPage && (
                <button type="button" disabled={selectingAll} onClick={selectAllMatching} className="text-harbor hover:underline disabled:opacity-60">
                  {selectingAll ? "Selecting…" : matching != null ? `Select all ${matching.toLocaleString()} that match` : "Select all that match"}
                </button>
              )}
              <span className="ml-auto text-xs text-ink-muted">Tick conflicts, then Solve for proposed berths.</span>
            </div>
          )}
          <ul className="space-y-2">
            {items.map((c) => (
              <ConflictCard key={c.id} c={c} selectable={canSelect} checked={sel.has(c.id)}
                onCheck={(on) => editSel((m) => { if (on) m.set(c.id, c.type); else m.delete(c.id); })}
                onResolved={() => editSel((m) => { m.delete(c.id); })} />
            ))}
          </ul>
        </>
      )}
      {list.hasNextPage && (
        <Button variant="outline" size="sm" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
          {list.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}

      {type && <BulkDismiss type={type} n={s?.byType[type] ?? 0} open={bulk} onOpenChange={setBulk}
        onDone={() => editSel((m) => { for (const [id, t] of m) if (t === type) m.delete(id); })} />}

      {sel.size > 0 && (
        <div role="region" aria-label="Auto-resolve" className="sticky bottom-4 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-surface/95 p-2.5 pl-4 shadow-lg backdrop-blur">
          <span className="text-sm font-medium"><span className="num">{sel.size.toLocaleString()}</span> selected</span>
          <button type="button" className="text-xs text-harbor hover:underline" onClick={() => setPicked(new Map())}>Clear</button>
          <span className="hidden text-xs text-ink-muted md:inline">{describeOptions(opts)}</span>
          <div className="ml-auto flex items-center gap-2">
            <SolveOptionsPopover value={opts} onChange={setOpts} />
            <Button size="sm" onClick={() => solve.mutate()} disabled={solve.isPending || tooMany}>
              {solve.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {solve.isPending ? "Solving…" : `Solve ${sel.size.toLocaleString()}`}
            </Button>
          </div>
          {tooMany && <p className="basis-full text-xs text-signal">Solve takes at most {MAX_SOLVE.toLocaleString()} at a time. Untick some, or filter by type.</p>}
          {solve.error && <p role="alert" className="basis-full text-xs text-signal">{errorMessage(solve.error)}</p>}
        </div>
      )}

      {review && (
        <ProposalReview key={review.run} result={review.result}
          onClose={() => setReview(null)}
          onRerun={() => setReview(null)}
          onApplied={(ids) => { editSel((m) => { for (const id of ids) m.delete(id); }); refresh(); setReview(null); }} />
      )}
    </div>
  );
}

function Chip({ active, children, ...rest }: { active: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} aria-pressed={active}
      className={cn("h-8 rounded-full border px-3 text-sm", active ? "border-harbor bg-harbor text-primary-foreground" : "bg-surface text-ink-muted hover:text-ink")}>
      {children}
    </button>
  );
}

function Empty({ status, filtered, total }: { status: ConflictStatus; filtered: boolean; total: number }) {
  const { pid } = useProjectCtx();
  return (
    <div className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-ink-muted">
      {filtered ? "Nothing matches these filters." :
       status !== "open" ? `Nothing ${status} yet.` :
       total === 0 ? <>No conflicts. Every row from your imports is on the schedule, or there hasn&rsquo;t been an import yet. <Link className="text-harbor hover:underline" href={`/p/${pid}/import`}>Import a spreadsheet</Link></> :
       "Nothing here."}
    </div>
  );
}

function useRefresh() {
  const { pid } = useProjectCtx();
  const qc = useQueryClient();
  return () => { for (const k of ["conflicts", "schedule", "bookings", "vessels", "availability"]) qc.invalidateQueries({ queryKey: [pid, k] }); };
}

function BulkDismiss({ type, n, open, onOpenChange, onDone }: { type: ConflictType; n: number; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const { api } = useProjectCtx();
  const refresh = useRefresh();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api.dismissConflicts({ type, reason: reason.trim() || undefined }),
    onSuccess: (r) => { toast.success(`Dismissed ${plural(r.dismissed, "conflict")}.`); refresh(); onDone(); onOpenChange(false); },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Dismiss all {plural(n, "“" + CONFLICT_LABEL[type].name + "” conflict")}?</DialogTitle>
          <DialogDescription>They won&rsquo;t be booked. You can still see them under Dismissed.</DialogDescription>
        </DialogHeader>
        <Input autoFocus placeholder="Reason (optional), e.g. historical, not actionable" value={reason} onChange={(e) => setReason(e.target.value)} />
        {m.error && <p className="text-sm text-signal">{errorMessage(m.error)}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Keep them</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending && <Loader2 className="animate-spin" />} Dismiss {n}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConflictCard({ c, selectable, checked, onCheck, onResolved }:
  { c: Conflict; selectable: boolean; checked: boolean; onCheck: (on: boolean) => void; onResolved: () => void }) {
  const { pid, api } = useProjectCtx();
  const editor = useBookingEditor();
  const refresh = useRefresh();
  const [mode, setMode] = useState<"none" | "place" | "dismiss">("none");
  const [reason, setReason] = useState("");
  const [start, setStart] = useState(c.startDate);
  const [end, setEnd] = useState(c.endDate);
  const [lenDraft, setLenDraft] = useState("");
  const needsLength = c.occupantType === "vessel" && c.vesselLengthFt == null;
  const lengthFt = c.vesselLengthFt ?? (Number(lenDraft) > 0 ? Number(lenDraft) : null);
  const datesOk = isISODate(start) && isISODate(end) && start <= end;
  const moved = start !== c.startDate || end !== c.endDate;

  const avail = useQuery({
    queryKey: qk.availability(pid, { s: start, e: end, l: lengthFt }),
    queryFn: () => api.availability({ startDate: start, endDate: end, ...(lengthFt ? { lengthFt } : {}) }),
    enabled: mode === "place" && datesOk && (!needsLength || lengthFt != null),
  });
  const resolve = useMutation({
    mutationFn: (body: ResolveConflictInput) => api.resolveConflict(c.id, body),
    onSuccess: (x) => { toast.success(x.status === "placed" ? `Booked ${c.title}.` : "Dismissed."); setMode("none"); onResolved(); refresh(); },
  });
  const place = (berthId: string) => resolve.mutate({
    action: "place", berthId, ...(moved ? { startDate: start, endDate: end } : {}),
    ...(needsLength && lengthFt ? { vesselLengthFt: lengthFt } : {}),
  });

  const open = c.status === "open";
  return (
    <li className={cn("rounded-xl border border-l-4 bg-surface p-3.5", open ? "border-l-signal" : "border-l-ink-muted/40 opacity-80", checked && "ring-2 ring-harbor/40")}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {selectable && open && <Checkbox checked={checked} onChange={(e) => onCheck(e.target.checked)} aria-label={`Select ${c.title}, ${formatRange(c.startDate, c.endDate)}`} />}
        <span className="rounded bg-signal-soft px-1.5 py-0.5 text-[11px] font-semibold text-signal" title={CONFLICT_LABEL[c.type].help}>
          {CONFLICT_LABEL[c.type].name}
        </span>
        <span className="inline-flex items-center gap-1.5 font-medium"><OccupantIcon type={c.occupantType} /> {c.title}</span>
        <span className="num">{formatRange(c.startDate, c.endDate)}</span>
        <span className="num ml-auto text-xs text-ink-muted">{c.sheet}{c.cell ? ` · ${c.cell}` : ""}</span>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs">
        <span className="text-ink-muted">{occupantLabel[c.occupantType]}</span>
        {c.occupantType === "vessel" && <span className="num">LOA {ft(c.vesselLengthFt)}</span>}
        <span>asked for {c.berthName ? <b>{c.berthName}</b> : c.berthLabel ? <q>{c.berthLabel}</q> : <i>no berth</i>}
          {c.berthLengthFt != null && <span className="num text-ink-muted"> ({ft(c.berthLengthFt)})</span>}</span>
        {c.type === "VESSEL_TOO_LONG" && c.vesselLengthFt != null && c.berthLengthFt != null && (
          <span className="num text-signal">short by {ft(c.vesselLengthFt - c.berthLengthFt)}</span>
        )}
      </div>

      <p className="mt-1.5 text-sm text-ink-muted">{c.message}</p>

      {(c.type === "OVERLAP" || c.type === "VESSEL_DOUBLE_BERTHED") && open && (
        c.blockers.length ? (
          <p className="mt-1.5 text-xs">In the way now:{" "}
            {c.blockers.map((b, i) => (
              <span key={b.bookingId}>{i > 0 && ", "}
                <button type="button" className="text-harbor hover:underline" onClick={() => editor.openDetail(b.bookingId)}>
                  {b.title}</button> <span className="num text-ink-muted">({b.berthName}, {formatRange(b.startDate, b.endDate)})</span>
              </span>
            ))}
          </p>
        ) : <p className="mt-1.5 text-xs text-ok">Nothing is in the way any more: it can go on its original berth.</p>
      )}

      {!open && (
        <p className="mt-1.5 text-xs text-ink-muted">
          {c.status === "placed" ? <>Placed{c.bookingIds.length > 1 && <> in {c.bookingIds.length} parts</>}{c.bookingIds.map((id, i) => (
              <span key={id}> · <button type="button" className="text-harbor hover:underline" onClick={() => editor.openDetail(id)}>{c.bookingIds.length > 1 ? `part ${i + 1}` : "view booking"}</button></span>
            ))}</> :
           <>Dismissed{c.resolutionNote && <>: {c.resolutionNote}</>}</>}
        </p>
      )}

      {open && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button size="sm" variant={mode === "place" ? "secondary" : "outline"} onClick={() => setMode(mode === "place" ? "none" : "place")}>Place…</Button>
          <Button size="sm" variant="ghost" onClick={() => setMode(mode === "dismiss" ? "none" : "dismiss")}>Dismiss</Button>
        </div>
      )}

      {mode === "dismiss" && (
        <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); resolve.mutate({ action: "dismiss", reason: reason.trim() || undefined }); }}>
          <Input autoFocus placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button type="submit" size="sm" disabled={resolve.isPending}>Dismiss</Button>
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Close" onClick={() => setMode("none")}><X /></Button>
        </form>
      )}

      {mode === "place" && (
        <div className="mt-3 space-y-3 border-t pt-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1"><Label htmlFor={`s-${c.id}`} className="text-xs">From</Label>
              <Input id={`s-${c.id}`} type="date" className="num h-7 w-36" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor={`e-${c.id}`} className="text-xs">To</Label>
              <Input id={`e-${c.id}`} type="date" className="num h-7 w-36" value={end} min={start} onChange={(e) => setEnd(e.target.value)} /></div>
            {moved && <button type="button" className="pb-1 text-xs text-harbor hover:underline" onClick={() => { setStart(c.startDate); setEnd(c.endDate); }}>reset days</button>}
            {needsLength && (
              <div className="space-y-1"><Label htmlFor={`len-${c.id}`} className="text-xs">No length on record — LOA (ft)</Label>
                <Input id={`len-${c.id}`} inputMode="decimal" className="num h-7 w-28" value={lenDraft} onChange={(e) => setLenDraft(e.target.value)} /></div>
            )}
          </div>
          {!datesOk && <p className="text-xs text-signal">From must be on or before To.</p>}
          {avail.isLoading && <p className="text-xs text-ink-muted">Finding berths for {formatRange(start, end)}…</p>}
          {avail.data && (
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {avail.data.options.map((o) => {
                const ok = o.free && o.fits !== false;   // null = no length on record: placeable, fit unverified
                return (
                  <li key={o.berth.id}>
                    <button type="button" disabled={!ok || resolve.isPending} onClick={() => place(o.berth.id)}
                      className={cn("flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-sm",
                        ok ? "hover:border-ok hover:bg-ok-soft" : "cursor-not-allowed opacity-50", o.berth.id === c.berthId && "ring-1 ring-harbor/40")}>
                      <span>{o.berth.name} <span className="num text-xs text-ink-muted">{ft(o.berth.lengthFt)}</span>
                        {o.berth.id === c.berthId && <span className="ml-1 text-[10px] text-harbor">asked for</span>}</span>
                      <span className={cn("num text-xs", ok ? "text-ok" : "text-signal")}>
                        {ok ? (o.slackFt != null ? `+${ft(o.slackFt)}` : o.fits === null ? "free · fit unknown" : "free") : o.fits === false ? `short ${ft(-(o.slackFt ?? 0))}` : `held by ${o.conflicts[0]?.title ?? "another booking"}`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {resolve.error && (
        <p className="mt-2 rounded-md border border-signal/40 bg-signal-soft px-2.5 py-1.5 text-sm">
          {resolve.error instanceof ApiRequestError && resolve.error.body.error.violations?.length
            ? resolve.error.body.error.violations.map((v) => v.message).join(" ") : errorMessage(resolve.error)}
        </p>
      )}
    </li>
  );
}
