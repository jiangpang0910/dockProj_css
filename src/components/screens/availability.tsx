"use client";
// Availability (frontend.md §3.3): "I have a 120 ft vessel 3–9 March — where can it go?" Tightest fit first.
import { useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { CheckCircle2, OctagonX, Ruler } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { addDays, formatRange, isISODate, spanDays } from "@/lib/dates";
import { ft, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useBookingEditor } from "@/components/booking/booking-editor";
import { VesselPicker } from "@/components/booking/vessel-picker";
import { useProjectCtx, useToday, useVessels } from "@/components/project/project-context";
import { ErrorBox, PageHeader } from "./page-header";

export function AvailabilityScreen() {
  const { pid, api } = useProjectCtx();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const today = useToday();
  const editor = useBookingEditor();
  const vessels = useVessels();

  const start = params.get("start") ?? today ?? "";
  const end = params.get("end") ?? (today ? addDays(today, 4) : "");
  const vesselId = params.get("vesselId") ?? "";
  const lengthFt = params.get("lengthFt") ?? "";
  const set = (patch: Record<string, string>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    router.replace(`${pathname}?${p}`, { scroll: false });
  };
  const vessel = vessels.data?.find((v) => v.id === vesselId);

  const query = useMemo(() => ({
    startDate: start, endDate: end,
    ...(vesselId && vessel?.lengthFt != null ? { vesselId } : lengthFt ? { lengthFt: Number(lengthFt) } : {}),
  }), [start, end, vesselId, vessel?.lengthFt, lengthFt]);
  const ready = isISODate(start) && isISODate(end) && end >= start;
  const res = useQuery({ queryKey: qk.availability(pid, query), queryFn: () => api.availability(query), enabled: ready, placeholderData: (p) => p });
  const opts = res.data?.options ?? [];
  const good = opts.filter((o) => o.free && o.fits === true);
  const unsure = opts.filter((o) => o.free && o.fits === null);   // free, but the berth has no length on record
  const bad = opts.filter((o) => !o.free || o.fits === false);

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-3 sm:p-5">
      <PageHeader title="Availability" sub="Free and long enough, tightest fit first." />

      <div className="grid gap-3 rounded-xl border bg-surface p-4 sm:grid-cols-[1fr_1fr_1.6fr_7rem]">
        <div className="space-y-1.5"><Label htmlFor="av-s">Arrives</Label>
          <Input id="av-s" type="date" className="num" value={start} onChange={(e) => set({ start: e.target.value, ...(e.target.value > end ? { end: e.target.value } : {}) })} /></div>
        <div className="space-y-1.5"><Label htmlFor="av-e">Departs (inclusive)</Label>
          <Input id="av-e" type="date" className="num" min={start} value={end} onChange={(e) => set({ end: e.target.value })} /></div>
        <div className="space-y-1.5"><Label>Vessel</Label>
          <VesselPicker value={vesselId} onChange={(v) => set({ vesselId: v.id, lengthFt: "" })} /></div>
        <div className="space-y-1.5"><Label htmlFor="av-l">…or length</Label>
          <Input id="av-l" inputMode="decimal" placeholder="ft" className="num" value={vessel?.lengthFt != null ? String(vessel.lengthFt) : lengthFt}
            onChange={(e) => set({ lengthFt: e.target.value.replace(/[^\d.]/g, ""), vesselId: "" })} /></div>
      </div>
      {vessel && vessel.lengthFt == null && (
        <p className="rounded-md border border-brass/50 bg-brass-soft px-3 py-2 text-sm">{vessel.name} has no length on record — type a length to check fit.</p>
      )}

      {!ready ? <p className="text-sm text-ink-muted">Choose arrival and departure dates.</p> :
       res.error ? <ErrorBox message={errorMessage(res.error)} onRetry={() => res.refetch()} /> :
       res.isLoading ? <div className="grid gap-3 sm:grid-cols-2">{Array.from({ length: 4 }, (_, i) => <div key={i} className="h-28 animate-pulse rounded-xl bg-muted" />)}</div> : (
        <div className="space-y-6">
          <p className="num text-sm text-ink-muted">
            {formatRange(start, end)} · {plural(spanDays(start, end), "day")}
            {res.data?.lengthFt != null && <> · for a <b className="text-ink">{ft(res.data.lengthFt)}</b> vessel</>}
            {" "}— <b className="text-ok">{good.length}</b> of {opts.length} berths work
          </p>
          {good.length === 0 && <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-ink-muted">No berth is both free and long enough for those days. Try moving the dates.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            {good.map((o, i) => (
              <motion.div key={o.berth.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}
                className={cn("flex items-center gap-3 rounded-xl border bg-surface p-4", i === 0 && "border-ok/60 shadow-[0_0_0_3px_color-mix(in_oklab,var(--ok)_14%,transparent)]")}>
                <CheckCircle2 className="size-5 shrink-0 text-ok" />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{o.berth.name} <span className="num text-sm font-normal text-ink-muted">{ft(o.berth.lengthFt)}</span></p>
                  <p className="num text-sm text-ok">{o.slackFt != null ? `+${ft(o.slackFt)} spare` : "free"}{i === 0 && o.slackFt != null && " · tightest fit"}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => editor.openNew({ berthId: o.berth.id, startDate: start, endDate: end, ...(vesselId ? { occupantType: "vessel", vesselId } : {}) })}>Book</Button>
              </motion.div>
            ))}
          </div>
          {unsure.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-[11px] font-semibold tracking-[0.12em] text-ink-muted uppercase">Free, fit unknown</h2>
              <ul className="divide-y rounded-xl border bg-surface">
                {unsure.map((o) => (
                  <li key={o.berth.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                    <span className="w-44 font-medium">{o.berth.name} <span className="num font-normal text-ink-muted">{ft(o.berth.lengthFt)}</span></span>
                    <span className="inline-flex items-center gap-1 text-ink-muted"><Ruler className="size-3.5" /> No length on record — add it on the Berths page to check fit</span>
                    <span className="flex-1" />
                    <Button size="sm" variant="ghost" onClick={() => editor.openNew({ berthId: o.berth.id, startDate: start, endDate: end, ...(vesselId ? { occupantType: "vessel", vesselId } : {}) })}>Book anyway</Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {bad.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-[11px] font-semibold tracking-[0.12em] text-ink-muted uppercase">Won&rsquo;t work</h2>
              <ul className="divide-y rounded-xl border bg-surface opacity-80">
                {bad.map((o) => (
                  <li key={o.berth.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                    <span className="w-44 font-medium">{o.berth.name} <span className="num font-normal text-ink-muted">{ft(o.berth.lengthFt)}</span></span>
                    {o.fits === false && <span className="inline-flex items-center gap-1 text-signal"><Ruler className="size-3.5" /> Too short by <span className="num">{ft(-(o.slackFt ?? 0))}</span></span>}
                    {!o.free && o.conflicts.slice(0, 2).map((c) => (
                      <button key={c.bookingId} type="button" onClick={() => editor.openDetail(c.bookingId)} className="inline-flex items-center gap-1 text-ink-muted hover:text-ink">
                        <OctagonX className="size-3.5 text-signal" /> Held by {c.title} <span className="num">{formatRange(c.startDate, c.endDate)}</span>
                      </button>
                    ))}
                    {o.conflicts.length > 2 && <span className="text-ink-muted">+{o.conflicts.length - 2} more</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
