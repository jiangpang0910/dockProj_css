"use client";
// The booking editor: one provider that owns the New/Edit booking dialog (§3.2) and the booking detail drawer.
// Anything in a project can call openNew(prefill) / openEdit(booking) / openDetail(id).
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { toast } from "sonner";
import { CalendarRange, Pencil, RotateCcw, XCircle } from "lucide-react";
import {
  DATE_MAX, DATE_MIN, type BookingInput, type BookingView, type OccupantType, type ScheduleResponse, type Violation,
} from "@shared/contract";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ApiRequestError, errorMessage, qs } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { formatDay, formatRange, isISODate, spanDays, spokenRange } from "@/lib/dates";
import { ft, occupantLabel, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useBerths, useProjectCtx, useToday, useVessels } from "@/components/project/project-context";
import { FitBar } from "./fit-bar";
import { OccupantIcon } from "./occupant";
import { StatusPanel, type CheckState } from "./status-panel";
import { VesselPicker } from "./vessel-picker";

type Prefill = Partial<BookingInput>;
interface EditorApi {
  openNew: (prefill?: Prefill) => void;
  openEdit: (b: BookingView) => void;
  openDetail: (id: string) => void;
}
const EditorCtx = createContext<EditorApi | null>(null);
export function useBookingEditor(): EditorApi {
  const c = useContext(EditorCtx);
  if (!c) throw new Error("useBookingEditor outside BookingEditorProvider");
  return c;
}

type FormMode = { kind: "new"; prefill: Prefill; key: number } | { kind: "edit"; booking: BookingView; key: number };

export function BookingEditorProvider({ children }: { children: React.ReactNode }) {
  const [form, setForm] = useState<FormMode | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const api = useMemo<EditorApi>(() => ({
    openNew: (prefill = {}) => { setDetail(null); setForm({ kind: "new", prefill, key: Date.now() }); },
    openEdit: (booking) => { setDetail(null); setForm({ kind: "edit", booking, key: Date.now() }); },
    openDetail: (id) => setDetail(id),
  }), []);
  return (
    <EditorCtx.Provider value={api}>
      {children}
      <Dialog open={!!form} onOpenChange={(o) => { if (!o) setForm(null); }}>
        {form && <BookingForm key={form.key} mode={form} onClose={() => setForm(null)} />}
      </Dialog>
      <BookingDrawer id={detail} onClose={() => setDetail(null)} />
    </EditorCtx.Provider>
  );
}

// ───────────────────────── the form ─────────────────────────

interface FormValues { occupantType: OccupantType; vesselId: string; title: string; berthId: string; startDate: string; endDate: string; notes: string }

function invalidateBookings(qc: ReturnType<typeof useQueryClient>, pid: string) {
  for (const k of ["schedule", "bookings", "booking", "availability"]) qc.invalidateQueries({ queryKey: [pid, k] });
  qc.invalidateQueries({ queryKey: qk.project(pid) });
}

function BookingForm({ mode, onClose }: { mode: FormMode; onClose: () => void }) {
  const { pid, api } = useProjectCtx();
  const qc = useQueryClient();
  const router = useRouter();
  const editor = useBookingEditor();
  const today = useToday();
  const berths = useBerths();
  const vessels = useVessels();
  const editing = mode.kind === "edit" ? mode.booking : null;
  const [version, setVersion] = useState(editing?.version ?? 0);
  const [stale, setStale] = useState(false);

  const defaults: FormValues = editing
    ? { occupantType: editing.occupantType, vesselId: editing.vesselId ?? "", title: editing.occupantType === "vessel" ? "" : editing.title,
        berthId: editing.berthId, startDate: editing.startDate, endDate: editing.endDate, notes: editing.notes ?? "" }
    : { occupantType: mode.kind === "new" ? mode.prefill.occupantType ?? "vessel" : "vessel", vesselId: (mode.kind === "new" && mode.prefill.vesselId) || "",
        title: (mode.kind === "new" && mode.prefill.title) || "", berthId: (mode.kind === "new" && mode.prefill.berthId) || "",
        startDate: (mode.kind === "new" && mode.prefill.startDate) || today || "", endDate: (mode.kind === "new" && mode.prefill.endDate) || today || "", notes: "" };
  const { register, control, setValue, handleSubmit, reset } = useForm<FormValues>({ defaultValues: defaults });
  const v = useWatch({ control }) as FormValues;

  const berth = berths.data?.find((b) => b.id === v.berthId);
  const vessel = vessels.data?.find((x) => x.id === v.vesselId);

  // ── live validation: debounce 250 ms, only with all required fields, cancel the previous request ──
  // results are stored with the input they answer; anything else on screen is derived (idle / checking)
  const [result, setResult] = useState<{ key: string; state: CheckState } | null>(null);
  const [nonce, setNonce] = useState(0);
  const input = useMemo<BookingInput>(() => ({
    berthId: v.berthId, occupantType: v.occupantType,
    vesselId: v.occupantType === "vessel" ? v.vesselId || null : null,
    title: v.occupantType === "vessel" ? null : v.title?.trim() || null,
    startDate: v.startDate, endDate: v.endDate, notes: v.notes?.trim() || null,
  }), [v.berthId, v.occupantType, v.vesselId, v.title, v.startDate, v.endDate, v.notes]);
  const missing = [
    !v.berthId && "a berth",
    v.occupantType === "vessel" ? !v.vesselId && "a vessel" : !v.title?.trim() && "a title",
    (!isISODate(v.startDate) || !isISODate(v.endDate)) && "dates",
  ].filter(Boolean) as string[];
  const ready = missing.length === 0;
  const checkKey = JSON.stringify({ ...input, notes: undefined, nonce });

  useEffect(() => {
    if (!ready) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api.validate({ ...input, excludeBookingId: editing?.id }, ctl.signal)
        .then((r) => setResult({ key: checkKey, state: { kind: "done", violations: r.violations } }))
        .catch((e) => { if ((e as Error).name !== "AbortError") setResult({ key: checkKey, state: { kind: "error", message: errorMessage(e) } }); });
    }, 250);
    return () => { clearTimeout(t); ctl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey, ready]);
  const check: CheckState = !ready ? { kind: "idle", missing } : result?.key === checkKey ? result.state : { kind: "checking" };
  const setCheck = (state: CheckState) => setResult({ key: checkKey, state });

  const blocked = check.kind === "done" && check.violations.some((x) => x.severity === "error");

  const save = useMutation({
    mutationFn: () => editing
      ? api.updateBooking(editing.id, { ...input, expectedVersion: version })
      : api.createBooking(input),
    onSuccess: (b) => {
      invalidateBookings(qc, pid);
      toast.success(`${editing ? "Updated" : "Booked"}: ${b.title}, ${b.berthName}, ${formatRange(b.startDate, b.endDate)}`);
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiRequestError) {
        if (e.body.error.code === "STALE_VERSION") { setStale(true); return; }
        if (e.body.error.violations) { setCheck({ kind: "done", violations: e.body.error.violations as Violation[] }); return; }
      }
      setCheck({ kind: "error", message: errorMessage(e) });
    },
  });

  const reload = async () => {
    if (!editing) return;
    const fresh = await api.getBooking(editing.id);
    reset({ occupantType: fresh.occupantType, vesselId: fresh.vesselId ?? "", title: fresh.occupantType === "vessel" ? "" : fresh.title,
            berthId: fresh.berthId, startDate: fresh.startDate, endDate: fresh.endDate, notes: fresh.notes ?? "" });
    setVersion(fresh.version); setStale(false);
    invalidateBookings(qc, pid);
  };

  const findBerth = () => {
    onClose();
    router.push(`/p/${pid}/availability?${qs({ start: v.startDate, end: v.endDate, vesselId: v.occupantType === "vessel" ? v.vesselId : undefined })}`);
  };

  // Inline "Add length" for a vessel with no length on record, then re-validate.
  const [lenDraft, setLenDraft] = useState("");
  const fixLength = useMutation({
    mutationFn: () => api.updateVessel(v.vesselId, { lengthFt: Number(lenDraft) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: [pid, "vessels"] }); setLenDraft(""); setNonce((n) => n + 1); },
  });
  const lengthFixer = (
    <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (Number(lenDraft) > 0) fixLength.mutate(); }}>
      <Input aria-label="Vessel length in feet" placeholder="LOA ft" inputMode="decimal" className="num h-7 w-24" value={lenDraft} onChange={(e) => setLenDraft(e.target.value)} />
      <Button type="submit" size="sm" disabled={!(Number(lenDraft) > 0) || fixLength.isPending}>Add length</Button>
      {fixLength.error && <span className="text-xs text-signal">{errorMessage(fixLength.error)}</span>}
    </form>
  );

  const types: OccupantType[] = ["vessel", "event", "closure"];
  const days = isISODate(v.startDate) && isISODate(v.endDate) && v.endDate >= v.startDate ? spanDays(v.startDate, v.endDate) : null;

  return (
    <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{editing ? "Edit booking" : "New booking"}</DialogTitle>
        <DialogDescription>
          {editing ? `${editing.title} · version ${version}` : "The berth is checked as you type — conflicts show up before you save."}
        </DialogDescription>
      </DialogHeader>

      <form id="booking-form" className="space-y-4" onSubmit={handleSubmit(() => save.mutate())}>
        <div role="radiogroup" aria-label="Type" className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
          {types.map((t) => (
            <button key={t} type="button" role="radio" aria-checked={v.occupantType === t}
              onClick={() => setValue("occupantType", t)}
              className={cn("flex items-center justify-center gap-1.5 rounded-md py-1.5 text-sm transition-colors",
                v.occupantType === t ? "bg-surface font-medium shadow-sm" : "text-ink-muted hover:text-ink")}>
              <OccupantIcon type={t} /> {occupantLabel[t]}
            </button>
          ))}
        </div>

        {v.occupantType === "vessel" ? (
          <div className="space-y-1.5">
            <Label>Vessel</Label>
            <VesselPicker value={v.vesselId} onChange={(x) => setValue("vesselId", x.id)} />
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="bk-title">Title</Label>
            <Input id="bk-title" placeholder={v.occupantType === "event" ? "Community sail day" : "Maintenance — bollard repair"} {...register("title")} />
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="bk-berth">Berth</Label>
          {/* controlled: the berth list can arrive after the dialog opens, and an uncontrolled select would drop the prefill */}
          <select id="bk-berth" value={v.berthId ?? ""} onChange={(e) => setValue("berthId", e.target.value)}
            className="h-8 w-full rounded-lg border border-input bg-surface px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <option value="">Choose a berth…</option>
            {berths.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} · {ft(b.lengthFt)}
                {vessel?.lengthFt != null && b.lengthFt != null && vessel.lengthFt > b.lengthFt ? "  (too short)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="bk-start">Arrives</Label>
            <Input id="bk-start" type="date" min={DATE_MIN} max={DATE_MAX} className="num" {...register("startDate", {
              onChange: (e) => { if (v.endDate && e.target.value > v.endDate) setValue("endDate", e.target.value); },
            })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bk-end">Departs (inclusive)</Label>
            <Input id="bk-end" type="date" min={v.startDate || DATE_MIN} max={DATE_MAX} className="num" {...register("endDate")} />
          </div>
        </div>
        {days != null && <p className="num -mt-2 text-xs text-ink-muted">{plural(days, "day")} on the berth · {spokenRange(v.startDate, v.endDate)}</p>}

        <div className="space-y-1.5">
          <Label htmlFor="bk-notes">Notes</Label>
          <Textarea id="bk-notes" rows={2} placeholder="Shore power, ETA, contact…" {...register("notes")} />
        </div>

        <StatusPanel state={check} vessel={vessel} berth={berth}
          onOpenBooking={(id) => editor.openDetail(id)} onFindBerth={findBerth} lengthFixer={lengthFixer} />

        {stale && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-signal/40 bg-signal-soft p-3 text-sm">
            <span>This booking changed since you opened it.</span>
            <Button type="button" size="sm" variant="outline" onClick={reload}><RotateCcw /> Reload</Button>
          </div>
        )}
      </form>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" form="booking-form" disabled={!ready || blocked || save.isPending || stale}>
          {save.isPending ? "Saving…" : editing ? "Save changes" : "Book it"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// ───────────────────────── the drawer ─────────────────────────

function BookingDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { pid, api } = useProjectCtx();
  const qc = useQueryClient();
  const editor = useBookingEditor();
  const [confirming, setConfirming] = useState(false);
  // keep showing the last booking while the sheet animates closed
  const [shownId, setShownId] = useState(id);
  if (id && id !== shownId) setShownId(id);
  const q = useQuery({ queryKey: qk.booking(pid, shownId ?? ""), queryFn: () => api.getBooking(shownId!), enabled: !!shownId });
  const b = q.data;

  // Optimistic cancel (the only optimistic update, frontend.md §4): the bar disappears at once, and returns on failure.
  const cancel = useMutation({
    mutationFn: () => api.cancelBooking(b!.id, b!.version),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: [pid, "schedule"] });
      const snapshots = qc.getQueriesData<ScheduleResponse>({ queryKey: [pid, "schedule"] });
      qc.setQueriesData<ScheduleResponse>({ queryKey: [pid, "schedule"] }, (old) => old && { ...old, bookings: old.bookings.filter((x) => x.id !== b!.id) });
      return { snapshots };
    },
    onError: (e, _v, ctx) => {
      ctx?.snapshots.forEach(([k, data]) => qc.setQueryData(k, data));
      toast.error(errorMessage(e));
    },
    onSuccess: (x) => { toast.success(`Cancelled ${x.title}, ${formatRange(x.startDate, x.endDate)}. ${x.berthName} is free again.`); setConfirming(false); onClose(); },
    onSettled: () => invalidateBookings(qc, pid),
  });

  return (
    <>
      <Sheet open={!!id} onOpenChange={(o) => { if (!o) onClose(); }}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
          {q.isLoading || !b ? (
            <div className="space-y-3 p-6">
              {q.error ? <p className="text-sm text-signal">{errorMessage(q.error)}</p> : <><Skeleton className="h-6 w-2/3" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-24 w-full" /></>}
            </div>
          ) : (
            <motion.div initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} className="flex h-full flex-col">
              <SheetHeader className="border-b">
                <div className="flex items-center gap-2 text-xs text-ink-muted">
                  <OccupantIcon type={b.occupantType} /> {occupantLabel[b.occupantType]}
                  <span>·</span> {b.source === "import" ? "Imported" : "Booked by hand"}
                  {b.status === "cancelled" && <span className="rounded bg-muted px-1.5 font-medium">Cancelled</span>}
                </div>
                <SheetTitle className="text-xl">{b.title}</SheetTitle>
                <SheetDescription className="num">{b.berthName} · {formatRange(b.startDate, b.endDate)}</SheetDescription>
              </SheetHeader>
              <div className="flex-1 space-y-5 overflow-y-auto p-4 text-sm">
                <dl className="grid grid-cols-[7rem_1fr] gap-y-2">
                  <dt className="text-ink-muted">Arrives</dt><dd className="num">{formatDay(b.startDate)}</dd>
                  <dt className="text-ink-muted">Departs</dt><dd className="num">{formatDay(b.endDate)}</dd>
                  <dt className="text-ink-muted">Occupies</dt><dd className="num">{plural(spanDays(b.startDate, b.endDate), "day")}</dd>
                  <dt className="text-ink-muted">Berth</dt><dd>{b.berthName} <span className="num text-ink-muted">{b.berthLengthFt == null ? "shared" : ft(b.berthLengthFt)}</span></dd>
                  {b.occupantType === "vessel" && <><dt className="text-ink-muted">LOA</dt><dd className="num">{ft(b.vesselLengthFt)}</dd></>}
                </dl>
                {b.vesselLengthFt != null && b.berthLengthFt != null && <FitBar vesselFt={b.vesselLengthFt} berthFt={b.berthLengthFt} />}
                {b.notes && <div><p className="mb-1 text-xs font-medium tracking-wide text-ink-muted uppercase">Notes</p><p className="whitespace-pre-wrap">{b.notes}</p></div>}
                <p className="num text-xs text-ink-muted">version {b.version}</p>
              </div>
              {b.status === "confirmed" && (
                <div className="flex gap-2 border-t p-4">
                  <Button variant="outline" className="flex-1" onClick={() => editor.openEdit(b)}><Pencil /> Edit</Button>
                  <Button variant="destructive" className="flex-1" onClick={() => setConfirming(true)}><XCircle /> Cancel booking</Button>
                </div>
              )}
            </motion.div>
          )}
        </SheetContent>
      </Sheet>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Cancel this booking?</DialogTitle>
            <DialogDescription>{b ? `${b.title} on ${b.berthName}, ${formatRange(b.startDate, b.endDate)}. The berth becomes free for those days; the booking stays in history.` : ""}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Keep it</Button>
            <Button variant="destructive" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancel booking</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function NewBookingIcon() { return <CalendarRange aria-hidden />; }
