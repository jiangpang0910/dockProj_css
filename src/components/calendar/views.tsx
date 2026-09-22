"use client";
// Day-scale boards and year-scale overviews: the non-timeline cells of the lens × scale matrix (frontend.md §3.1).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, Plus } from "lucide-react";
import type { Berth, BookingView, ISODate } from "@shared/contract";
import { MONTHS, addDays, diffDays, eachDay, formatDay, formatRange, parts, spanDays } from "@/lib/dates";
import { ft, plural } from "@/lib/format";
import { qk } from "@/lib/api/keys";
import { cn } from "@/lib/utils";
import { OccupantIcon, occupantStyle } from "@/components/booking/occupant";
import { useProjectCtx } from "@/components/project/project-context";
import { clip } from "./model";

const covers = (b: BookingView, d: ISODate) => b.startDate <= d && b.endDate >= d;
const byStart = (a: BookingView, b: BookingView) => (a.startDate < b.startDate ? -1 : 1);

function Chip({ b, onOpen, sub }: { b: BookingView; onOpen: (id: string) => void; sub?: React.ReactNode }) {
  return (
    <button type="button" onClick={() => onOpen(b.id)}
      className={cn("flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm hover:brightness-95", occupantStyle[b.occupantType])}>
      <OccupantIcon type={b.occupantType} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{b.title}</span>
        <span className="num block text-xs text-ink-muted">{formatRange(b.startDate, b.endDate)}{sub ? <> · {sub}</> : null}</span>
      </span>
      {b.vesselLengthFt != null && <span className="num text-xs text-ink-muted">{ft(b.vesselLengthFt)}</span>}
    </button>
  );
}

// ───────── day × all berths: the dock board ─────────
export function DockBoard({ berths, bookings, day, onOpen, onCreate }: {
  berths: Berth[]; bookings: BookingView[]; day: ISODate; onOpen: (id: string) => void; onCreate: (berthId: string, d: ISODate) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {berths.map((berth) => {
        const mine = bookings.filter((b) => b.berthId === berth.id).sort(byStart);
        const here = mine.filter((b) => covers(b, day));
        const next = mine.find((b) => b.startDate > day);
        return (
          <section key={berth.id} className="rounded-xl border bg-surface p-3">
            <header className="mb-2.5 flex items-baseline justify-between gap-2">
              <h3 className="truncate font-semibold">{berth.name}</h3>
              <span className="num text-xs text-ink-muted">{ft(berth.lengthFt)}</span>
            </header>
            {here.length ? (
              <div className="space-y-1.5">
                {here.map((b) => (
                  <div key={b.id}>
                    <Chip b={b} onOpen={onOpen} sub={`day ${diffDays(b.startDate, day) + 1} of ${spanDays(b.startDate, b.endDate)}`} />
                    <div className="mt-1 flex gap-1.5 text-[11px]">
                      {b.startDate === day && <span className="inline-flex items-center gap-0.5 rounded bg-ok-soft px-1.5 py-0.5 text-ok"><ArrowDownLeft className="size-3" /> arriving today</span>}
                      {b.endDate === day && <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-ink-muted"><ArrowUpRight className="size-3" /> departing today</span>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <button type="button" onClick={() => onCreate(berth.id, day)}
                className="group flex w-full items-center justify-between rounded-md border border-dashed border-ok/40 bg-ok-soft/60 px-2.5 py-3 text-left text-sm">
                <span>
                  <span className="font-semibold text-ok">Free</span>
                  <span className="num block text-xs text-ink-muted">{next ? `until ${formatDay(addDays(next.startDate, -1))} · ${plural(diffDays(day, next.startDate), "day")}` : "nothing booked ahead"}</span>
                </span>
                <Plus className="size-4 text-ok opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ───────── day × one berth: agenda ─────────
export function BerthAgenda({ berth, bookings, day, onOpen, onCreate }: {
  berth: Berth; bookings: BookingView[]; day: ISODate; onOpen: (id: string) => void; onCreate: (berthId: string, d: ISODate) => void;
}) {
  const mine = bookings.filter((b) => b.berthId === berth.id).sort(byStart);
  const here = mine.filter((b) => covers(b, day));
  const prev = [...mine].reverse().find((b) => b.endDate < day);
  const next = mine.find((b) => b.startDate > day);
  const freeFrom = prev ? addDays(prev.endDate, 1) : null;
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Section title="Before">
        {prev ? <Chip b={prev} onOpen={onOpen} /> : <Empty>Nothing earlier in the loaded six months.</Empty>}
      </Section>
      <Section title={formatDay(day)} accent>
        {here.length ? here.map((b) => <Chip key={b.id} b={b} onOpen={onOpen} sub={`day ${diffDays(b.startDate, day) + 1} of ${spanDays(b.startDate, b.endDate)}`} />) : (
          <button type="button" onClick={() => onCreate(berth.id, day)} className="w-full rounded-md border border-dashed border-ok/40 bg-ok-soft/60 px-3 py-4 text-left">
            <span className="font-semibold text-ok">Free</span>
            <span className="num block text-sm text-ink-muted">
              {freeFrom && next ? `free for ${plural(diffDays(freeFrom, next.startDate), "day")} (${formatRange(freeFrom, addDays(next.startDate, -1))})`
                : next ? `free until ${formatDay(addDays(next.startDate, -1))}` : "free, nothing booked ahead"} · book it →
            </span>
          </button>
        )}
      </Section>
      <Section title="After">
        {next ? <Chip b={next} onOpen={onOpen} sub={`in ${plural(diffDays(day, next.startDate), "day")}`} /> : <Empty>Nothing booked in the next six months.</Empty>}
      </Section>
    </div>
  );
}

// ───────── day × all vessels: in port today ─────────
export function InPortToday({ bookings, day, onOpen, onVessel }: {
  bookings: BookingView[]; day: ISODate; onOpen: (id: string) => void; onVessel: (vesselId: string) => void;
}) {
  const here = bookings.filter((b) => b.occupantType === "vessel" && covers(b, day)).sort((a, b) => a.berthName.localeCompare(b.berthName));
  if (!here.length) return <Empty>No vessels at the dock on {formatDay(day)}.</Empty>;
  return (
    <div className="overflow-hidden rounded-xl border bg-surface">
      <table className="w-full text-sm">
        <thead className="border-b text-left text-[11px] tracking-wide text-ink-muted uppercase">
          <tr><th className="px-3 py-2 font-medium">Vessel</th><th className="px-3 py-2 font-medium">LOA</th><th className="px-3 py-2 font-medium">Berth</th><th className="px-3 py-2 font-medium">Stay</th><th className="px-3 py-2 font-medium">Left</th></tr>
        </thead>
        <tbody>
          {here.map((b) => (
            <tr key={b.id} className="border-b last:border-0 hover:bg-accent">
              <td className="px-3 py-2"><button type="button" className="font-medium hover:underline" onClick={() => onVessel(b.vesselId!)}>{b.title}</button></td>
              <td className="num px-3 py-2">{ft(b.vesselLengthFt)}</td>
              <td className="px-3 py-2">{b.berthName}</td>
              <td className="num px-3 py-2"><button type="button" className="hover:underline" onClick={() => onOpen(b.id)}>day {diffDays(b.startDate, day) + 1} of {spanDays(b.startDate, b.endDate)}</button></td>
              <td className="num px-3 py-2 text-ink-muted">{b.endDate === day ? "departs today" : plural(diffDays(day, b.endDate), "day")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ───────── day × one vessel: where is it ─────────
export function VesselWhereabouts({ vesselId, day, onOpen }: { vesselId: string; day: ISODate; onOpen: (id: string) => void }) {
  const { pid, api } = useProjectCtx();
  // ±1 year around the day, in two windows (each ≤ MAX_WINDOW_DAYS)
  const back = useQuery({ queryKey: qk.bookings(pid, { vesselId, from: addDays(day, -365), to: day }), queryFn: () => api.listBookings({ vesselId, from: addDays(day, -365), to: day }) });
  const ahead = useQuery({ queryKey: qk.bookings(pid, { vesselId, from: day, to: addDays(day, 365) }), queryFn: () => api.listBookings({ vesselId, from: day, to: addDays(day, 365) }) });
  const all = useMemo(() => {
    const m = new Map<string, BookingView>();
    for (const b of [...(back.data ?? []), ...(ahead.data ?? [])]) m.set(b.id, b);
    return [...m.values()].sort(byStart);
  }, [back.data, ahead.data]);
  if (back.isLoading || ahead.isLoading) return <div className="mx-auto h-48 max-w-2xl animate-pulse rounded-xl bg-muted" />;
  const here = all.find((b) => covers(b, day));
  const last = [...all].reverse().find((b) => b.endDate < day);
  const next = all.find((b) => b.startDate > day);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Section title={`On ${formatDay(day)}`} accent>
        {here ? <Chip b={here} onOpen={onOpen} sub={`at ${here.berthName}`} /> : <Empty>Not at the dock.</Empty>}
      </Section>
      <Section title="Last visit">{last ? <Chip b={last} onOpen={onOpen} sub={`${last.berthName} · ${plural(diffDays(last.endDate, day), "day")} ago`} /> : <Empty>No visit in the past year.</Empty>}</Section>
      <Section title="Next visit">{next ? <Chip b={next} onOpen={onOpen} sub={`${next.berthName} · in ${plural(diffDays(day, next.startDate), "day")}`} /> : <Empty>Nothing booked in the next year.</Empty>}</Section>
    </div>
  );
}

// ───────── year × all berths: heatmap ─────────
export function YearHeatmap({ berths, bookings, from, to, today, onMonth }: {
  berths: Berth[]; bookings: BookingView[]; from: ISODate; to: ISODate; today?: ISODate; onMonth: (d: ISODate) => void;
}) {
  const days = useMemo(() => eachDay(from, to), [from, to]);
  const grid = useMemo(() => berths.map((berth) => {
    const cells = new Map<ISODate, { n: number; type: BookingView["occupantType"] }>();
    for (const b of bookings) {
      if (b.berthId !== berth.id) continue;
      const c = clip(b, from, to); if (!c) continue;
      for (let d = c.s; d <= c.e; d = addDays(d, 1)) {
        const cur = cells.get(d);
        cells.set(d, { n: (cur?.n ?? 0) + 1, type: cur?.type === "vessel" ? "vessel" : b.occupantType });
      }
    }
    return { berth, cells, occupied: cells.size };
  }), [berths, bookings, from, to]);
  const months = days.map((d, i) => ({ d, i })).filter(({ d }) => parts(d)[2] === 1);
  return (
    <div className="overflow-x-auto rounded-xl border bg-surface p-3">
      <div className="min-w-[720px]">
        <div className="relative mb-1 ml-44 h-5">
          {months.map(({ d, i }) => (
            <button key={d} type="button" onClick={() => onMonth(d)} className="absolute text-[11px] font-semibold text-ink-muted hover:text-harbor"
              style={{ left: `${(i / days.length) * 100}%` }}>{MONTHS[parts(d)[1] - 1]}</button>
          ))}
        </div>
        {grid.map(({ berth, cells, occupied }) => (
          <div key={berth.id} className="flex items-center gap-2 py-1">
            <div className="flex w-42 shrink-0 items-baseline justify-between gap-2 pr-2 text-sm">
              <span className="truncate font-medium">{berth.name}</span>
              <span className="num text-[11px] text-ink-muted">{`${Math.round((occupied / days.length) * 100)}%`}</span>
            </div>
            <div className="grid h-6 flex-1 gap-px" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
              role="img" aria-label={`${berth.name}: occupied ${occupied} of ${days.length} days`}>
              {days.map((d) => {
                const c = cells.get(d);
                return <span key={d} title={c ? `${formatDay(d)} · ${c.n > 1 ? `${c.n} bookings` : c.type}` : formatDay(d)}
                  className={cn("rounded-[1px]", !c && (parts(d)[2] === 1 ? "bg-ink-muted/25" : "bg-muted"), c?.type === "closure" && "bg-ink-muted/60", d === today && "outline outline-1 outline-harbor")}
                  style={c && c.type !== "closure" ? { background: c.type === "event" ? "var(--brass)" : `color-mix(in oklab, var(--harbor) ${Math.min(100, 55 + c.n * 15)}%, transparent)` } : undefined} />;
              })}
            </div>
          </div>
        ))}
        <p className="mt-3 flex flex-wrap gap-4 text-[11px] text-ink-muted">
          <Legend className="bg-harbor" label="vessel" /><Legend className="bg-brass" label="event" /><Legend className="bg-ink-muted/60" label="closure" /><Legend className="bg-muted" label="free" />
          <span>Click a month to open it.</span>
        </p>
      </div>
    </div>
  );
}

// ───────── year × all vessels: ranked by days in port ─────────
export function VesselsYear({ bookings, from, to, onVessel }: {
  bookings: BookingView[]; from: ISODate; to: ISODate; onVessel: (id: string) => void;
}) {
  const rows = useMemo(() => {
    const m = new Map<string, { id: string; name: string; loa: number | null; days: number; visits: number; perMonth: number[] }>();
    for (const b of bookings) {
      if (b.occupantType !== "vessel" || !b.vesselId) continue;
      const c = clip(b, from, to); if (!c) continue;
      const r = m.get(b.vesselId) ?? { id: b.vesselId, name: b.title, loa: b.vesselLengthFt, days: 0, visits: 0, perMonth: Array(12).fill(0) };
      r.visits += 1;
      for (let d = c.s; d <= c.e; d = addDays(d, 1)) { r.days += 1; r.perMonth[parts(d)[1] - 1] += 1; }
      m.set(b.vesselId, r);
    }
    return [...m.values()].sort((a, b) => b.days - a.days);
  }, [bookings, from, to]);
  if (!rows.length) return <Empty>No vessel visits this year.</Empty>;
  const max = Math.max(...rows.flatMap((r) => r.perMonth), 1);
  return (
    <div className="overflow-hidden rounded-xl border bg-surface">
      <table className="w-full text-sm">
        <thead className="border-b text-left text-[11px] tracking-wide text-ink-muted uppercase">
          <tr><th className="px-3 py-2 font-medium">#</th><th className="px-3 py-2 font-medium">Vessel</th><th className="px-3 py-2 font-medium">LOA</th><th className="px-3 py-2 text-right font-medium">Days in port</th><th className="px-3 py-2 text-right font-medium">Visits</th><th className="px-3 py-2 font-medium">Jan → Dec</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className="border-b last:border-0 hover:bg-accent">
              <td className="num px-3 py-1.5 text-ink-muted">{i + 1}</td>
              <td className="px-3 py-1.5"><button type="button" className="font-medium hover:underline" onClick={() => onVessel(r.id)}>{r.name}</button></td>
              <td className="num px-3 py-1.5">{ft(r.loa)}</td>
              <td className="num px-3 py-1.5 text-right font-medium">{r.days}</td>
              <td className="num px-3 py-1.5 text-right text-ink-muted">{r.visits}</td>
              <td className="px-3 py-1.5">
                <div className="flex h-5 items-end gap-px" role="img" aria-label={`Days per month: ${r.perMonth.join(", ")}`}>
                  {r.perMonth.map((n, k) => <span key={k} className="w-2 rounded-t-[1px] bg-harbor/70" style={{ height: `${Math.max(n ? 12 : 4, (n / max) * 100)}%`, opacity: n ? 1 : 0.25 }} />)}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Section({ title, children, accent }: { title: string; children: React.ReactNode; accent?: boolean }) {
  return (
    <section>
      <h3 className={cn("mb-1.5 text-[11px] font-semibold tracking-[0.12em] uppercase", accent ? "text-harbor" : "text-ink-muted")}>{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}
export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed px-3 py-4 text-sm text-ink-muted">{children}</p>;
}
function Legend({ className, label }: { className: string; label: string }) {
  return <span className="inline-flex items-center gap-1.5"><span className={cn("size-2.5 rounded-[2px]", className)} />{label}</span>;
}
