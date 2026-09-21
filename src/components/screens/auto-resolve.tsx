"use client";
// Auto-resolve (contract.ts, "auto-resolve"): the user ticks conflicts, sets options, and asks the solver for
// PROPOSED berths. Nothing changes until they tick the proposals they like and press Apply.
//   SolveOptionsPopover — the knobs.   ProposalReview — the result: segments, shift, slack, tick boxes, Apply.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, Loader2, RotateCcw, SlidersHorizontal, TriangleAlert } from "lucide-react";
import type { Proposal, SolveResult, SolveSkipReason } from "@shared/contract";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ApiRequestError, errorMessage } from "@/lib/api/client";
import { formatRange, spanDays } from "@/lib/dates";
import { ft, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { OccupantIcon } from "@/components/booking/occupant";
import { useProjectCtx } from "@/components/project/project-context";

// ───────────────────────── options ─────────────────────────

/** Every option filled in: the shape the server echoes back in SolveResult.options. */
export type SolveSettings = SolveResult["options"];
export const DEFAULT_SOLVE_OPTIONS: SolveSettings = {
  maxDelayDays: 3, maxEarlyDays: 0, maxMoves: 1, minSegmentDays: 2, timeLimitSec: 10,
  weights: { delay: 2, early: 3, move: 3 },
};
const sameOptions = (a: SolveSettings, b: SolveSettings) => JSON.stringify(a) === JSON.stringify(b);

/** One line for the action bar, e.g. "up to 3 days later · 1 berth change". */
export function describeOptions(o: SolveSettings): string {
  const parts = [`up to ${plural(o.maxDelayDays, "day")} later`];
  if (o.maxEarlyDays > 0) parts.push(`up to ${plural(o.maxEarlyDays, "day")} earlier`);
  parts.push(o.maxMoves === 0 ? "no berth changes" : `${plural(o.maxMoves, "berth change")}`);
  return parts.join(" · ");
}

export function SolveOptionsPopover({ value, onChange }: { value: SolveSettings; onChange: (v: SolveSettings) => void }) {
  const set = (patch: Partial<Omit<SolveSettings, "weights">>) => onChange({ ...value, ...patch });
  const setW = (patch: Partial<SolveSettings["weights"]>) => onChange({ ...value, weights: { ...value.weights, ...patch } });
  const changed = !sameOptions(value, DEFAULT_SOLVE_OPTIONS);
  return (
    <Popover>
      <PopoverTrigger className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")} aria-label="Solver options">
        <SlidersHorizontal /> Options
        {changed && <span aria-label="changed from defaults" className="size-1.5 rounded-full bg-brass" />}
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-88 gap-3 p-3">
        <div>
          <p className="font-medium">How far may the solver move things?</p>
          <p className="text-xs text-ink-muted">Only the ticked conflicts move. Bookings already on the schedule never do.</p>
        </div>
        <NumField label="May arrive later by" unit="days" min={0} max={14} value={value.maxDelayDays} onChange={(v) => set({ maxDelayDays: v })}
          help="Shifts the whole stay later, keeping its length." />
        <NumField label="May arrive earlier by" unit="days" min={0} max={14} value={value.maxEarlyDays} onChange={(v) => set({ maxEarlyDays: v })}
          help="Off by default: the vessel probably isn't there yet." />
        <NumField label="Berth changes in one stay" unit="max" min={0} max={3} value={value.maxMoves} onChange={(v) => set({ maxMoves: v })}
          help="0 keeps each stay on one berth. 1 lets it split across two." />
        <NumField label="Shortest part of a split stay" unit="days" min={1} max={7} value={value.minSegmentDays} onChange={(v) => set({ minSegmentDays: v })}
          help="Stops a stay being cut into one-day pieces." />
        <details className="group rounded-md border px-2.5 py-2">
          <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium text-ink-muted">
            Advanced <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-2.5 space-y-3">
            <p className="text-xs text-ink-muted">Cost of each kind of disruption. The solver first places as many as it can, then keeps this total low.</p>
            <NumField label="Each day later" unit="cost" min={0} max={100} value={value.weights.delay} onChange={(v) => setW({ delay: v })} />
            <NumField label="Each day earlier" unit="cost" min={0} max={100} value={value.weights.early} onChange={(v) => setW({ early: v })} />
            <NumField label="Each berth change" unit="cost" min={0} max={100} value={value.weights.move} onChange={(v) => setW({ move: v })} />
            <NumField label="Time limit" unit="sec" min={1} max={30} value={value.timeLimitSec} onChange={(v) => set({ timeLimitSec: v })}
              help="If it runs out, you still get valid proposals, just maybe not the best." />
          </div>
        </details>
        {changed && (
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => onChange(DEFAULT_SOLVE_OPTIONS)}>
            <RotateCcw /> Back to defaults
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** A small integer input that only commits (clamped) on blur / Enter, so typing "1" on the way to "12" works. */
function NumField({ label, unit, help, value, min, max, onChange }:
  { label: string; unit: string; help?: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  const id = `opt-${label.replace(/\W+/g, "-").toLowerCase()}`;
  const [draft, setDraft] = useState(String(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) { setSeen(value); setDraft(String(value)); }   // "Back to defaults" changes value from outside
  const commit = () => {
    const n = Math.round(Number(draft));
    const v = draft.trim() !== "" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : value;
    setDraft(String(v));
    if (v !== value) onChange(v);
  };
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5">
      <Label htmlFor={id} className="text-xs font-medium">{label}</Label>
      <div className="flex items-center gap-1.5">
        <Input id={id} inputMode="numeric" className="num h-7 w-14 text-right" value={draft} aria-describedby={help ? `${id}-help` : undefined}
          onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
        <span className="w-8 text-[11px] text-ink-muted">{unit}</span>
      </div>
      {help && <p id={`${id}-help`} className="col-span-2 text-[11px] leading-snug text-ink-muted">{help} <span className="num">({min}–{max})</span></p>}
    </div>
  );
}

// ───────────────────────── review ─────────────────────────

const STATUS: Record<SolveResult["status"], { label: string; cls: string }> = {
  OPTIMAL: { label: "Best placement found", cls: "bg-ok-soft text-ok" },
  FEASIBLE: { label: "Valid, but the time limit hit — may not be the best", cls: "bg-brass-soft text-brass" },
  NO_SOLUTION: { label: "Nothing could be placed", cls: "bg-signal-soft text-signal" },
};
const SKIP: Record<SolveSkipReason, string> = {
  CLOSURE: "Closure",
  LENGTH_UNKNOWN: "Length unknown",
  NO_BERTH_LONG_ENOUGH: "Too long for every berth",
  NO_ROOM: "No room",
  NOT_OPEN: "Already handled",
};

export function ProposalReview({ result, onClose, onRerun, onApplied }: {
  result: SolveResult;
  onClose: () => void;
  onRerun: () => void;                       // "Change options": close this and go back to the selection
  onApplied: (conflictIds: string[]) => void;
}) {
  const { api } = useProjectCtx();
  const [ticked, setTicked] = useState(() => new Set(result.proposals.map((p) => p.conflictId)));
  const total = result.proposals.length;
  const n = ticked.size;

  const apply = useMutation({
    mutationFn: () => api.applyProposals({
      proposals: result.proposals.filter((p) => ticked.has(p.conflictId)).map((p) => ({
        conflictId: p.conflictId,
        segments: p.segments.map((s) => ({ berthId: s.berthId, startDate: s.startDate, endDate: s.endDate })),
      })),
    }),
    onSuccess: (r) => {
      toast.success(`Placed ${plural(r.placed, "conflict")} as ${plural(r.bookingIds.length, "booking")}.`);
      onApplied(result.proposals.filter((p) => ticked.has(p.conflictId)).map((p) => p.conflictId));
    },
  });
  const stale = apply.error instanceof ApiRequestError && apply.error.status === 409;

  const toggle = (id: string) => setTicked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const st = STATUS[result.status];
  const s = result.stats;

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !apply.isPending) onClose(); }}>
      <DialogContent className="max-h-[92vh] grid-rows-[auto_auto_minmax(0,1fr)_auto] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Proposed placements</DialogTitle>
          <DialogDescription>
            The solver worked on {plural(s.selected, "conflict")}. Nothing is booked until you apply. Untick any you don&rsquo;t want.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={cn("rounded px-1.5 py-0.5 font-medium", st.cls)}>{st.label}</span>
            <span className="num text-ink-muted">solved in {s.solveMs < 1000 ? `${Math.round(s.solveMs)} ms` : `${(s.solveMs / 1000).toFixed(1)} s`}</span>
          </div>
          <dl className="grid grid-cols-2 divide-x rounded-lg border sm:grid-cols-4">
            <Stat label="Placed" value={s.placed.toLocaleString()} of={s.selected} />
            <Stat label="Berth changes mid-stay" value={s.moves.toLocaleString()} />
            <Stat label="Days later, in total" value={s.delayDays.toLocaleString()} />
            <Stat label="Spare length used" value={s.slackFootDays.toLocaleString()} unit="ft-days" />
          </dl>
        </div>

        <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
          {total > 0 ? (
            <>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={n === total} indeterminate={n > 0 && n < total}
                  onChange={() => setTicked(n === total ? new Set() : new Set(result.proposals.map((p) => p.conflictId)))} />
                <span>{n === total ? "All" : n} of {plural(total, "proposal")} ticked</span>
              </label>
              <ul className="space-y-2">
                {result.proposals.map((p) => <ProposalRow key={p.conflictId} p={p} checked={ticked.has(p.conflictId)} onToggle={() => toggle(p.conflictId)} />)}
              </ul>
            </>
          ) : (
            <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-ink-muted">
              No placements found. Allow more days, or a berth change, in Options and solve again.
            </p>
          )}

          {result.unplaced.length > 0 && (
            <details className="rounded-lg border">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                {plural(result.unplaced.length, "conflict")} couldn&rsquo;t be placed
              </summary>
              <ul className="divide-y border-t text-sm">
                {result.unplaced.map((u) => (
                  <li key={u.conflictId} className="px-3 py-2">
                    <span className="font-medium">{u.title}</span>{" "}
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-ink-muted">{SKIP[u.reason]}</span>
                    <p className="mt-0.5 text-xs text-ink-muted">{u.detail}</p>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <div className="space-y-2">
          {apply.error && (
            <p role="alert" className="flex items-start gap-2 rounded-md border border-signal/40 bg-signal-soft px-2.5 py-1.5 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-signal" />
              <span>
                {stale ? "The schedule changed since this was solved, so nothing was written. Solve again to get fresh proposals." : errorMessage(apply.error)}
                {stale && <> <button type="button" className="text-harbor hover:underline" onClick={onRerun}>Back to selection</button></>}
              </span>
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={onRerun} disabled={apply.isPending}>Change options</Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose} disabled={apply.isPending}>Cancel</Button>
              <Button onClick={() => apply.mutate()} disabled={n === 0 || apply.isPending}>
                {apply.isPending && <Loader2 className="animate-spin" />} Apply {n > 0 ? n.toLocaleString() : ""}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, of, unit }: { label: string; value: string; of?: number; unit?: string }) {
  return (
    <div className="px-3 py-2">
      <dt className="text-[11px] text-ink-muted">{label}</dt>
      <dd className="num text-lg font-semibold tracking-tight">
        {value}{of != null && <span className="text-sm font-normal text-ink-muted"> of {of.toLocaleString()}</span>}
        {unit && <span className="text-xs font-normal text-ink-muted"> {unit}</span>}
      </dd>
    </div>
  );
}

function ShiftChip({ days }: { days: number }) {
  if (days === 0) return <span className="text-xs text-ok">on the days asked</span>;
  return (
    <span className="rounded bg-brass-soft px-1.5 py-0.5 text-[11px] font-medium text-brass">
      {plural(Math.abs(days), "day")} {days > 0 ? "later" : "earlier"}
    </span>
  );
}

function ProposalRow({ p, checked, onToggle }: { p: Proposal; checked: boolean; onToggle: () => void }) {
  const split = p.segments.length > 1;
  const req = p.requested;
  return (
    <li className={cn("rounded-lg border bg-surface transition-colors", checked ? "border-harbor/40" : "opacity-60")}>
      <label className="flex cursor-pointer items-start gap-3 p-3">
        <Checkbox checked={checked} onChange={onToggle} className="mt-0.5" aria-label={`Apply the proposal for ${p.title}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="inline-flex items-center gap-1.5 font-medium"><OccupantIcon type={p.occupantType} /> {p.title}</span>
            {p.vesselLengthFt != null && <span className="num text-xs text-ink-muted">LOA {ft(p.vesselLengthFt)}</span>}
            <ShiftChip days={p.shiftDays} />
            {split && <span className="rounded bg-harbor-soft px-1.5 py-0.5 text-[11px] font-medium text-harbor">moves mid-stay</span>}
          </div>
          <p className="mt-0.5 text-xs text-ink-muted">
            Asked for {req.berthName ? <b className="font-medium text-ink">{req.berthName}</b> : <i>no berth</i>}{" "}
            <span className="num">{formatRange(req.startDate, req.endDate)}</span>
          </p>
          <ol className="mt-2 space-y-1">
            {p.segments.map((seg, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md bg-harbor-soft px-2.5 py-1.5 text-xs">
                {split && <span className="num flex size-4 items-center justify-center rounded-full bg-harbor text-[10px] font-semibold text-primary-foreground">{i + 1}</span>}
                <span className="font-medium">{seg.berthName}</span>
                <span className="num text-ink-muted">{seg.berthLengthFt != null ? ft(seg.berthLengthFt) : "shared"}</span>
                <span className="num">{formatRange(seg.startDate, seg.endDate)}</span>
                <span className="num text-ink-muted">{plural(spanDays(seg.startDate, seg.endDate), "day")}</span>
                <span className="num ml-auto" title="Berth length minus vessel length">
                  {seg.slackFt != null ? <>spare <b className="font-semibold">{ft(seg.slackFt)}</b></> : <span className="text-ink-muted">—</span>}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </label>
    </li>
  );
}
