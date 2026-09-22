"use client";
// Import (frontend.md §3.7): upload with a planning window → preview → commit / discard → triage issues.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { toast } from "sonner";
import { Bot, CheckCircle2, ChevronDown, FileSpreadsheet, Loader2, Trash2, X } from "lucide-react";
import type { ConflictType, ImportIssue, ImportRun } from "@shared/contract";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiRequestError, errorMessage } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { formatDay, formatInstant, formatRange, isISODate } from "@/lib/dates";
import { ft, occupantLabel, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { OccupantIcon } from "@/components/booking/occupant";
import { UploadBox, checkUpload } from "@/components/import/upload-box";
import { useProjectCtx, useSettings } from "@/components/project/project-context";
import { ErrorBox, PageHeader } from "./page-header";
import { CONFLICT_LABEL } from "./conflicts";

type Tab = "error" | "warning" | "info" | "resolved";

export function ImportScreen() {
  const { pid, api } = useProjectCtx();
  const router = useRouter(), pathname = usePathname(), params = useSearchParams();
  const runId = params.get("run");
  const runs = useQuery({ queryKey: qk.imports(pid), queryFn: () => api.listImports() });
  const setRun = (id: string | null) => router.replace(id ? `${pathname}?run=${id}` : pathname, { scroll: false });

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-3 sm:p-5">
      <PageHeader title="Import" sub="Upload our template to set up berths, vessels and bookings, or the original workbook to bring in its history. New bookings are the future." />
      {runId ? <RunView runId={runId} onBack={() => setRun(null)} /> : <Upload onDone={(r) => setRun(r.id)} />}
      <section className="space-y-2">
        <h2 className="text-[11px] font-semibold tracking-[0.12em] text-ink-muted uppercase">Past imports</h2>
        {runs.isLoading ? <div className="h-16 animate-pulse rounded-xl bg-muted" /> : !runs.data?.length ? (
          <p className="text-sm text-ink-muted">None yet.</p>
        ) : (
          <ul className="divide-y rounded-xl border bg-surface">
            {runs.data.map((r) => (
              <li key={r.id}>
                <Link href={`${pathname}?run=${r.id}`} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm hover:bg-accent", r.id === runId && "bg-harbor-soft")}>
                  <FileSpreadsheet className="size-4 text-ink-muted" />
                  <span className="font-medium">{r.filename}</span>
                  <FormatBadge format={r.format} />
                  <StatusBadge status={r.status} />
                  <span className="num ml-auto text-xs text-ink-muted">{plural(r.counts.bookings, "booking")} · {plural(r.counts.conflicts, "conflict")} · {plural(r.counts.issues, "issue")} · {formatInstant(r.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Upload({ onDone }: { onDone: (r: ImportRun) => void }) {
  const { pid, api } = useProjectCtx();
  const qc = useQueryClient();
  const settings = useSettings();
  const from = settings.data?.asOfDate;
  const [until, setUntil] = useState("");   // blank = the window is read from the file
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const up = useMutation({
    mutationFn: () => api.uploadImport(file!, until || undefined),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: qk.imports(pid) }); onDone(r); },
  });
  return (
    <section className="rounded-xl border bg-surface p-4 sm:p-5">
      <div className="grid gap-4 sm:grid-cols-[1fr_1fr_2fr]">
        <div className="space-y-1.5">
          <Label>Planning from</Label>
          <p className="num flex h-8 items-center text-sm font-medium">{from ? formatDay(from) : "…"}</p>
          <p className="text-[11px] text-ink-muted">The project&rsquo;s today — change it with the chip at the top.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="im-to">Planning until <span className="font-normal text-ink-muted">(optional)</span></Label>
          <Input id="im-to" type="date" className="num" min={from} value={until} onChange={(e) => setUntil(e.target.value)} />
          <p className="text-[11px] text-ink-muted">Blank: the dates come from the file.</p>
        </div>
        <p className="self-center text-sm text-ink-muted">
          {until
            ? <>Only bookings touching today → until are brought in. Everything else in the file is counted and skipped, so planning one season isn&rsquo;t buried under decades of history.</>
            : <>Everything in the file is brought in, whatever years it covers. If the project&rsquo;s today falls outside them, it moves to the file&rsquo;s first date when you commit, so the schedule opens on the data.</>}
        </p>
      </div>
      <UploadBox file={file} error={err} onFile={(f) => { setErr(null); if (!f) return; const p = checkUpload(f); if (p) setErr(p); else setFile(f); }} />
      <div className="mt-4 flex items-center gap-3">
        <Button disabled={!file || (until !== "" && !isISODate(until)) || up.isPending} onClick={() => up.mutate()}>
          {up.isPending && <Loader2 className="animate-spin" />}{up.isPending ? "Reading the spreadsheet…" : "Upload and preview"}
        </Button>
        <span className="text-xs text-ink-muted">Nothing is written to the schedule until you commit.</span>
      </div>
      {up.error && <p role="alert" className="mt-3 text-sm text-signal">{errorMessage(up.error)}</p>}
    </section>
  );
}

function CountUp({ value }: { value: number }) {
  const mv = useMotionValue(0);
  const text = useTransform(mv, (v) => Math.round(v).toLocaleString());
  useEffect(() => { const c = animate(mv, value, { duration: 0.9, ease: [0.2, 0.7, 0.2, 1] }); return () => c.stop(); }, [mv, value]);
  return <motion.span className="num">{text}</motion.span>;
}

function RunView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const { pid, api } = useProjectCtx();
  const qc = useQueryClient();
  const run = useQuery({ queryKey: qk.importRun(pid, runId), queryFn: () => api.getImport(runId) });
  const [confirm, setConfirm] = useState(false);
  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: qk.imports(pid) });
    for (const k of ["schedule", "bookings", "vessels", "berths", "availability"]) qc.invalidateQueries({ queryKey: [pid, k] });
    qc.invalidateQueries({ queryKey: qk.project(pid) });
  };
  const commit = useMutation({
    mutationFn: () => api.commitImport(runId),
    onSuccess: (r) => {
      qc.setQueryData(qk.importRun(pid, runId), r); refreshAll(); setConfirm(false);
      toast.success(`Committed ${plural(r.counts.bookings, "booking")}.`);
      if (r.todaySet) {
        qc.invalidateQueries({ queryKey: qk.settings(pid) });
        toast(`Today moved to ${formatDay(r.todaySet)} to match the file. Change it with the chip at the top.`);
      }
    },
  });
  const discard = useMutation({
    mutationFn: () => api.discardImport(runId),
    onSuccess: () => { refreshAll(); toast.success("Import discarded."); onBack(); },
  });

  if (run.error) return <ErrorBox message={errorMessage(run.error)} onRetry={() => run.refetch()} />;
  if (!run.data) return <div className="h-56 animate-pulse rounded-xl bg-muted" />;
  const r = run.data;
  const stats: { label: string; value: number; tone?: string }[] = [
    { label: "bookings to add", value: r.counts.bookings },
    { label: "vessels", value: r.counts.vessels },
    { label: "berths", value: r.counts.berths },
    { label: "conflicts", value: r.counts.conflicts, tone: r.counts.conflicts ? "text-signal" : undefined },
    { label: "errors", value: r.issueCounts.error, tone: r.issueCounts.error ? "text-signal" : undefined },
    { label: "warnings", value: r.issueCounts.warning, tone: r.issueCounts.warning ? "text-brass" : undefined },
  ];

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-xl border bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <FileSpreadsheet className="size-4 text-ink-muted" />
          <span className="font-semibold">{r.filename}</span>
          <FormatBadge format={r.format} /><StatusBadge status={r.status} />
          <button type="button" onClick={onBack} className="ml-auto text-sm text-harbor hover:underline">Upload another</button>
        </div>
        <div className="grid grid-cols-3 divide-x border-b sm:grid-cols-6">
          {stats.map((s) => (
            <div key={s.label} className="px-4 py-4">
              <p className={cn("text-2xl font-semibold tracking-tight", s.tone)}><CountUp value={s.value} /></p>
              <p className="text-xs text-ink-muted">{s.label}</p>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
          <p className="num text-ink-muted">
            Planning window <b className="text-ink">{formatRange(r.window.from, r.window.to)}</b>
            {r.counts.outsideWindow > 0 && <> · {r.counts.outsideWindow.toLocaleString()} bookings outside it were skipped</>}
            {" "}· {plural(r.counts.sheets, "sheet")}, {r.counts.cells.toLocaleString()} cells read
          </p>
          {r.status === "previewed" && (
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" onClick={() => discard.mutate()} disabled={discard.isPending}><Trash2 /> Discard</Button>
              <Button onClick={() => setConfirm(true)}>Commit {plural(r.counts.bookings, "booking")}</Button>
            </div>
          )}
          {r.status === "committed" && r.committedAt && <span className="ml-auto inline-flex items-center gap-1.5 text-ok"><CheckCircle2 className="size-4" /> Committed {formatInstant(r.committedAt)}</span>}
        </div>
        {r.counts.conflicts > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t bg-signal-soft/40 px-4 py-2.5 text-sm">
            <span className="font-medium">{plural(r.counts.conflicts, "row")} can&rsquo;t be placed as written:</span>
            {Object.entries(r.conflictCounts).map(([t, n]) => (
              <span key={t} className="num text-ink-muted">{CONFLICT_LABEL[t as ConflictType].name} {n}</span>
            ))}
            {r.status === "committed"
              ? <Link href={`/p/${pid}/conflicts`} className="ml-auto text-harbor hover:underline">Resolve on the Conflicts tab →</Link>
              : <span className="ml-auto text-xs text-ink-muted">They move to the Conflicts tab when you commit.</span>}
          </div>
        )}
      </section>

      <Issues run={r} />

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Commit this import?</DialogTitle>
            <DialogDescription>
              Adds {plural(r.counts.bookings, "booking")}{r.counts.berths ? `, ${plural(r.counts.berths, "berth")}` : ""} and new vessels to the schedule in one step.
              {r.counts.conflicts > 0 && ` ${plural(r.counts.conflicts, "row")} that can't be placed go to the Conflicts tab.`}
              {" "}Flagged cells stay as issues here.
            </DialogDescription>
          </DialogHeader>
          {commit.error && <p className="text-sm text-signal">{errorMessage(commit.error)}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Not yet</Button>
            <Button onClick={() => commit.mutate()} disabled={commit.isPending}>{commit.isPending && <Loader2 className="animate-spin" />} Commit</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Issues({ run }: { run: ImportRun }) {
  const { pid, api } = useProjectCtx();
  const [tab, setTab] = useState<Tab>(run.issueCounts.error ? "error" : run.issueCounts.warning ? "warning" : "info");
  const [code, setCode] = useState("");
  const filter = tab === "resolved" ? { resolved: true, code: code || undefined } : { severity: tab, resolved: false, code: code || undefined };
  const q = useInfiniteQuery({
    queryKey: qk.issues(pid, run.id, filter),
    queryFn: ({ pageParam }) => api.listIssues(run.id, { ...filter, cursor: pageParam ?? undefined, limit: 25 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const codes = useMemo(() => [...new Set(items.map((i) => i.code))].sort(), [items]);
  const tabs: { id: Tab; label: string; n?: number }[] = [
    { id: "error", label: "Errors", n: run.issueCounts.error }, { id: "warning", label: "Warnings", n: run.issueCounts.warning },
    { id: "info", label: "Info", n: run.issueCounts.info }, { id: "resolved", label: "Resolved" },
  ];
  // info is collapsed by default: grouped by code, expand to see rows
  const [infoOpen, setInfoOpen] = useState<string | null>(null);
  const grouped = useMemo(() => {
    const m = new Map<string, ImportIssue[]>();
    for (const i of items) m.set(i.code, [...(m.get(i.code) ?? []), i]);
    return [...m.entries()];
  }, [items]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Issues" className="inline-flex rounded-lg border bg-surface p-0.5">
          {tabs.map((t) => (
            <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} onClick={() => { setTab(t.id); setCode(""); }}
              className={cn("rounded-md px-3 py-1 text-sm", tab === t.id ? "bg-harbor text-primary-foreground" : "text-ink-muted hover:text-ink")}>
              {t.label}{t.n != null && <span className="num ml-1.5 opacity-80">{t.n}</span>}
            </button>
          ))}
        </div>
        <select aria-label="Filter by code" value={code} onChange={(e) => setCode(e.target.value)} className="h-8 rounded-lg border border-input bg-surface px-2 text-sm">
          <option value="">All codes</option>
          {codes.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {q.error ? <ErrorBox message={errorMessage(q.error)} onRetry={() => q.refetch()} /> :
       q.isLoading ? <div className="h-32 animate-pulse rounded-xl bg-muted" /> :
       items.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-ink-muted">
          {tab === "resolved" ? "Nothing resolved yet." : `No ${tab === "error" ? "errors" : tab === "warning" ? "warnings" : "info"} left. `}
          {tab === "error" && "Every row that needed a decision has one."}
        </p>
      ) : tab === "info" && !code ? (
        <ul className="divide-y rounded-xl border bg-surface">
          {grouped.map(([c, list]) => (
            <li key={c}>
              <button type="button" onClick={() => setInfoOpen(infoOpen === c ? null : c)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-accent">
                <CodeBadge code={c} /><span className="text-ink-muted">{list[0].message}{list.length > 1 ? ` (+${list.length - 1} similar)` : ""}</span>
                <span className="num ml-auto text-ink-muted">{list.length}</span>
                <ChevronDown className={cn("size-4 text-ink-muted transition-transform", infoOpen === c && "rotate-180")} />
              </button>
              {infoOpen === c && <ul className="space-y-2 bg-muted/30 p-3">{list.map((i) => <IssueCard key={i.id} issue={i} run={run} />)}</ul>}
            </li>
          ))}
        </ul>
      ) : (
        <ul className="space-y-2">
          {items.map((i) => <IssueCard key={i.id} issue={i} run={run} />)}
        </ul>
      )}
      {q.hasNextPage && <Button variant="outline" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage ? "Loading…" : "Load more"}</Button>}
    </section>
  );
}

function IssueCard({ issue, run }: { issue: ImportIssue; run: ImportRun }) {
  const { pid, api } = useProjectCtx();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"none" | "create" | "dismiss">("none");
  const [reason, setReason] = useState("");
  const [lenDraft, setLenDraft] = useState("");
  const row = issue.row;
  const lengthFt = row?.vesselLengthFt ?? (Number(lenDraft) > 0 ? Number(lenDraft) : null);
  const needsLength = row?.occupantType === "vessel" && row.vesselLengthFt == null;
  const avail = useQuery({
    queryKey: qk.availability(pid, { s: row?.startDate, e: row?.endDate, l: lengthFt }),
    queryFn: () => api.availability({ startDate: row!.startDate, endDate: row!.endDate, ...(lengthFt ? { lengthFt } : {}) }),
    enabled: mode === "create" && !!row && (!needsLength || lengthFt != null),
  });
  const done = () => {
    qc.invalidateQueries({ queryKey: [pid, "imports", run.id] });
    qc.invalidateQueries({ queryKey: qk.importRun(pid, run.id) });
    for (const k of ["schedule", "bookings", "vessels", "availability"]) qc.invalidateQueries({ queryKey: [pid, k] });
  };
  const resolve = useMutation({
    mutationFn: (body: Parameters<typeof api.resolveIssue>[2]) => api.resolveIssue(run.id, issue.id, body),
    onSuccess: (x) => { toast.success(x.resolution === "created" ? `Booked ${row?.title}.` : "Dismissed."); setMode("none"); done(); },
  });
  const tone = issue.severity === "error" ? "border-l-signal" : issue.severity === "warning" ? "border-l-brass" : "border-l-ink-muted/40";
  return (
    <li className={cn("rounded-xl border border-l-4 bg-surface p-3.5", tone, issue.resolved && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <CodeBadge code={issue.code} />
        <span className="num text-xs text-ink-muted">{issue.sheet}{issue.cell ? ` · ${issue.cell}` : ""}</span>
        {row?.classifiedBy === "model" && <span className="inline-flex items-center gap-1 rounded bg-harbor-soft px-1.5 py-0.5 text-[11px] text-harbor"><Bot className="size-3" /> classified by model</span>}
        {issue.resolved && <span className="ml-auto rounded bg-muted px-1.5 text-xs">{issue.resolution}</span>}
      </div>
      <p className="mt-1.5 text-sm">{issue.message}</p>
      {row && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs">
          <span className="inline-flex items-center gap-1.5 font-medium"><OccupantIcon type={row.occupantType} /> {row.title}</span>
          <span className="text-ink-muted">{occupantLabel[row.occupantType]}</span>
          <span className="num">{formatRange(row.startDate, row.endDate)}</span>
          {row.occupantType === "vessel" && <span className="num text-ink-muted">LOA {ft(row.vesselLengthFt)}</span>}
          <span className="text-ink-muted">row label: {row.berthLabel ? <q>{row.berthLabel}</q> : <i>none</i>}</span>
        </div>
      )}
      {!issue.resolved && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {row && <Button size="sm" variant={mode === "create" ? "secondary" : "outline"} disabled={run.status !== "committed"}
            title={run.status !== "committed" ? "Commit the import first" : undefined}
            onClick={() => setMode(mode === "create" ? "none" : "create")}>Create booking</Button>}
          <Button size="sm" variant="ghost" onClick={() => setMode(mode === "dismiss" ? "none" : "dismiss")}>Dismiss</Button>
        </div>
      )}
      {mode === "dismiss" && (
        <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); resolve.mutate({ action: "dismiss", reason: reason.trim() || undefined }); }}>
          <Input autoFocus placeholder="Reason (optional) — e.g. historical, not actionable" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button type="submit" size="sm" disabled={resolve.isPending}>Dismiss</Button>
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Close" onClick={() => setMode("none")}><X /></Button>
        </form>
      )}
      {mode === "create" && row && (
        <div className="mt-3 space-y-2 border-t pt-3">
          {needsLength && (
            <div className="flex items-end gap-2">
              <div className="space-y-1"><Label htmlFor={`len-${issue.id}`} className="text-xs">{row.title} has no length on record — LOA (ft)</Label>
                <Input id={`len-${issue.id}`} autoFocus inputMode="decimal" className="num h-7 w-28" value={lenDraft} onChange={(e) => setLenDraft(e.target.value)} /></div>
            </div>
          )}
          {avail.isLoading && <p className="text-xs text-ink-muted">Finding berths for {formatRange(row.startDate, row.endDate)}…</p>}
          {avail.data && (
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {avail.data.options.map((o) => {
                const ok = o.free && o.fits !== false;   // null = no length on record: placeable, fit unverified
                return (
                  <li key={o.berth.id}>
                    <button type="button" disabled={!ok || resolve.isPending}
                      onClick={() => resolve.mutate({ action: "create_booking", berthId: o.berth.id, ...(needsLength && lengthFt ? { vesselLengthFt: lengthFt } : {}) })}
                      className={cn("flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-sm", ok ? "hover:border-ok hover:bg-ok-soft" : "cursor-not-allowed opacity-50")}>
                      <span>{o.berth.name} <span className="num text-xs text-ink-muted">{ft(o.berth.lengthFt)}</span></span>
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

function CodeBadge({ code }: { code: string }) {
  return <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide">{code}</span>;
}
function FormatBadge({ format }: { format: ImportRun["format"] }) {
  return <span className="rounded border px-1.5 text-[10px] tracking-wide text-ink-muted uppercase">{format === "template" ? "our template" : format === "table" ? "free-form table" : "legacy grid"}</span>;
}
function StatusBadge({ status }: { status: ImportRun["status"] }) {
  const s = { previewed: "bg-brass-soft text-ink", committed: "bg-ok-soft text-ok", discarded: "bg-muted text-ink-muted" }[status];
  return <span className={cn("rounded px-1.5 text-[11px]", s)}>{status}</span>;
}
