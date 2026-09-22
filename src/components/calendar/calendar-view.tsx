"use client";
// The Calendar screen (frontend.md §3.1): lens × scale, all state in the URL, one /schedule call per window.
import { useCallback, useEffect, useMemo } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";
import type { BookingView, ISODate, OccupantType } from "@shared/contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { addDays, addMonths, diffDays, isISODate } from "@/lib/dates";
import { ft, occupantLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { OccupantIcon } from "@/components/booking/occupant";
import { useBookingEditor } from "@/components/booking/booking-editor";
import { useProjectCtx, useToday, useVessels } from "@/components/project/project-context";
import { HoverProvider } from "./hover";
import { MiniMonth, MonthCalendar } from "./month-calendar";
import {
  LENSES, SCALES, berthColors, fetchRange, occupancy, readState, step, title, viewRange, writeState,
  type CalState, type Lens, type Scale,
} from "./model";
import { BerthLabel, Timeline, type TimelineRow } from "./timeline";
import { BerthAgenda, DockBoard, Empty, InPortToday, VesselWhereabouts, VesselsYear, YearHeatmap } from "./views";

const MIN_COL: Record<Scale, number> = { day: 0, week: 96, month: 30, quarter: 11, year: 0 };
const TYPES: OccupantType[] = ["vessel", "event", "closure"];

export function CalendarView() {
  const { pid, api } = useProjectCtx();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const editor = useBookingEditor();
  const today = useToday();
  const vessels = useVessels();
  const state = readState(new URLSearchParams(params.toString()));
  const date = state.date ?? today;

  const set = useCallback((patch: Partial<CalState>) => {
    const next = { ...readState(new URLSearchParams(window.location.search)), ...patch };
    router.replace(`${pathname}?${writeState(next)}`, { scroll: false });
  }, [pathname, router]);

  const range = date ? fetchRange(state.scale, date) : null;
  const view = date ? viewRange(state.scale, date) : null;
  const sched = useQuery({
    queryKey: qk.schedule(pid, range?.from ?? "", range?.to ?? ""),
    queryFn: () => api.getSchedule(range!.from, range!.to),
    enabled: !!range,
    placeholderData: (prev) => prev,
  });

  // keyboard: ←/→ step, t today, d/w/m/q/y scale (the grid handles its own arrows)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [role=grid], [role=dialog], [contenteditable=true]")) return;
      if (!date) return;
      if (e.key === "ArrowLeft") set({ date: step(state.scale, date, -1) });
      else if (e.key === "ArrowRight") set({ date: step(state.scale, date, 1) });
      else if (e.key === "t") set({ date: null });
      else { const s = SCALES.find((x) => x.key === e.key); if (s) set({ scale: s.id }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [date, state.scale, set]);

  const data = sched.data;
  const allBerths = useMemo(() => data?.berths ?? [], [data]);
  const colors = useMemo(() => berthColors(allBerths), [allBerths]);
  const shownBerths = allBerths.filter((b) => !state.berths || state.berths.includes(b.id));
  const shownIds = new Set(shownBerths.map((b) => b.id));
  const typesKey = state.types.join(), idsKey = [...shownIds].join();
  const bookings = useMemo(() => {
    const types = typesKey.split(","), ids = new Set(idsKey.split(","));
    return (data?.bookings ?? []).filter((b) => types.includes(b.occupantType) && ids.has(b.berthId));
  }, [data, typesKey, idsKey]);

  // single-entity lenses need an id: default to the first berth / the busiest vessel in view
  const entityId = useMemo(() => {
    if (state.lens === "berth") return state.id && allBerths.some((b) => b.id === state.id) ? state.id : allBerths[0]?.id ?? null;
    if (state.lens === "vessel") {
      if (state.id) return state.id;
      const counts = new Map<string, number>();
      for (const b of data?.bookings ?? []) if (b.vesselId) counts.set(b.vesselId, (counts.get(b.vesselId) ?? 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? vessels.data?.[0]?.id ?? null;
    }
    return null;
  }, [state.lens, state.id, allBerths, data, vessels.data]);

  const openNew = (berthId: string | undefined, s: ISODate, e: ISODate) =>
    editor.openNew({ berthId, startDate: s, endDate: e, ...(state.lens === "vessel" && entityId ? { occupantType: "vessel", vesselId: entityId } : {}) });
  const toVessel = (id: string) => set({ lens: "vessel", id });

  return (
    <HoverProvider>
      <div className="space-y-4 p-3 sm:p-5">
        {/* ── controls ── */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="mr-auto min-w-0 font-display text-2xl leading-none tracking-tight sm:text-[1.75rem]">
            {date ? title(state.scale, date) : <span className="inline-block h-7 w-48 animate-pulse rounded bg-muted" />}
          </h1>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" aria-label="Previous" onClick={() => date && set({ date: step(state.scale, date, -1) })}><ChevronLeft /></Button>
            <Button variant="outline" size="sm" onClick={() => set({ date: null })}>Today</Button>
            <Button variant="outline" size="icon" aria-label="Next" onClick={() => date && set({ date: step(state.scale, date, 1) })}><ChevronRight /></Button>
            <Input type="date" aria-label="Go to date" className="num h-8 w-38" value={date ?? ""} onChange={(e) => isISODate(e.target.value) && set({ date: e.target.value })} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Segmented label="Lens" value={state.lens} options={LENSES.map((l) => ({ id: l.id, label: l.label }))} onChange={(lens) => set({ lens: lens as Lens, id: null })} />
          {state.lens === "berth" && (
            <select aria-label="Berth" value={entityId ?? ""} onChange={(e) => set({ id: e.target.value })}
              className="h-8 max-w-56 rounded-lg border border-input bg-surface px-2 text-sm">
              {allBerths.map((b) => <option key={b.id} value={b.id}>{b.name} · {ft(b.lengthFt)}</option>)}
            </select>
          )}
          {state.lens === "vessel" && (
            <select aria-label="Vessel" value={entityId ?? ""} onChange={(e) => set({ id: e.target.value })}
              className="h-8 max-w-64 rounded-lg border border-input bg-surface px-2 text-sm">
              {(vessels.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name} · {ft(v.lengthFt)}</option>)}
            </select>
          )}
          <div className="flex-1" />
          <Segmented label="Scale" value={state.scale} options={SCALES.map((s) => ({ id: s.id, label: s.label, hint: s.key }))} onChange={(scale) => set({ scale: scale as Scale })} />
          <Filters state={state} set={set} berths={allBerths} />
        </div>

        {/* ── body ── */}
        {!date || (sched.isLoading && !data) ? <GridSkeleton /> :
         sched.error && !data ? (
          <div className="rounded-xl border bg-surface p-6 text-sm">
            <p className="text-signal">{errorMessage(sched.error)}</p>
            <Button className="mt-3" size="sm" variant="outline" onClick={() => sched.refetch()}>Retry</Button>
          </div>
        ) : allBerths.length === 0 ? (
          <div className="rounded-xl border bg-surface p-8 text-center">
            <p className="font-medium">This project has no berths yet.</p>
            <p className="mt-1 text-sm text-ink-muted">Add them by hand, or upload a spreadsheet that has them.</p>
            <div className="mt-4 flex justify-center gap-2">
              <Link href={`/p/${pid}/berths`} className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm text-primary-foreground">Add berths</Link>
              <Link href={`/p/${pid}/import`} className="inline-flex h-8 items-center rounded-lg border px-3 text-sm">Upload a spreadsheet</Link>
            </div>
          </div>
        ) : (
          <motion.div key={`${state.lens}-${state.scale}`} initial={{ opacity: 0 }} animate={{ opacity: sched.isFetching ? 0.7 : 1 }} transition={{ duration: 0.15 }}>
            <Body
              state={state} date={date} view={view!} today={today} entityId={entityId}
              berths={shownBerths} allBerths={allBerths} bookings={bookings} allBookings={data?.bookings ?? []}
              colors={colors} onOpen={editor.openDetail} onCreate={openNew} toVessel={toVessel}
              toMonth={(d) => set({ scale: "month", date: d })}
            />
            {bookings.length === 0 && state.scale !== "day" && (
              <p className="mt-3 text-center text-sm text-ink-muted">
                Nothing booked {state.scale === "year" ? "this year" : `in this ${state.scale}`}.{" "}
                <button type="button" className="text-harbor hover:underline" onClick={() => editor.openNew({ startDate: view!.from, endDate: view!.from })}>Book something</button>
                {" "}or drag across a berth row.
              </p>
            )}
          </motion.div>
        )}
      </div>
    </HoverProvider>
  );
}

function Body({ state, date, view, today, entityId, berths, allBerths, bookings, allBookings, colors, onOpen, onCreate, toVessel, toMonth }: {
  state: CalState; date: ISODate; view: { from: ISODate; to: ISODate }; today?: ISODate; entityId: string | null;
  berths: import("@shared/contract").Berth[]; allBerths: import("@shared/contract").Berth[];
  bookings: BookingView[]; allBookings: BookingView[]; colors: Map<string, string>;
  onOpen: (id: string) => void; onCreate: (berthId: string | undefined, s: ISODate, e: ISODate) => void;
  toVessel: (id: string) => void; toMonth: (d: ISODate) => void;
}) {
  const { lens, scale } = state;
  const occ = scale !== "day" && scale !== "year" ? occupancy(allBerths, allBookings, view.from, view.to) : undefined;
  const vesselBar = (b: BookingView) => ({ text: b.occupantType === "vessel" ? `${b.title}${b.vesselLengthFt != null && scale === "week" ? ` · ${ft(b.vesselLengthFt)}` : ""}` : b.title });
  const berthBar = (b: BookingView) => ({ text: b.occupantType === "vessel" ? b.berthName : `${b.title} · ${b.berthName}`, color: colors.get(b.berthId) });
  const months = (n: number) => Array.from({ length: n }, (_, i) => addMonths(view.from, i));

  // ── all berths ──
  if (lens === "berths") {
    if (scale === "day") return <DockBoard berths={berths} bookings={bookings} day={date} onOpen={onOpen} onCreate={(id, d) => onCreate(id, d, d)} />;
    if (scale === "year") return <YearHeatmap berths={berths} bookings={bookings} from={view.from} to={view.to} today={today} onMonth={toMonth} />;
    const rows: TimelineRow[] = berths.map((b) => ({
      key: b.id, berthId: b.id, aria: `${b.name}, ${b.lengthFt == null ? "length not on record" : `${b.lengthFt} feet`}`,
      label: <BerthLabel name={b.name} lengthFt={b.lengthFt} inactive={!b.active} />,
      bookings: bookings.filter((x) => x.berthId === b.id),
    }));
    return <Timeline rows={rows} from={view.from} to={view.to} today={today} occupancy={occ} barText={vesselBar}
      onOpen={onOpen} onCreate={(id, s, e) => onCreate(id, s, e)} minColWidth={MIN_COL[scale]} rowNoun="Berth" />;
  }

  // ── one berth ──
  if (lens === "berth") {
    const berth = allBerths.find((b) => b.id === entityId);
    if (!berth) return <Empty>Choose a berth.</Empty>;
    const mine = bookings.filter((b) => b.berthId === berth.id);
    const label = (b: BookingView) => (b.occupantType === "vessel" && b.vesselLengthFt != null ? `${b.title} · ${ft(b.vesselLengthFt)}` : b.title);
    if (scale === "day") return <BerthAgenda berth={berth} bookings={bookings} day={date} onOpen={onOpen} onCreate={(id, d) => onCreate(id, d, d)} />;
    if (scale === "week") {
      return <Timeline rows={[{ key: berth.id, berthId: berth.id, aria: berth.name, label: <BerthLabel name={berth.name} lengthFt={berth.lengthFt} />, bookings: mine }]}
        from={view.from} to={view.to} today={today} occupancy={occ} barText={vesselBar} onOpen={onOpen} onCreate={(id, s, e) => onCreate(id, s, e)} minColWidth={96} rowNoun="Berth" />;
    }
    if (scale === "month") return <MonthCalendar month={view.from} bookings={mine} today={today} onOpen={onOpen} onDay={(d) => onCreate(berth.id, d, d)} labelOf={label} />;
    if (scale === "quarter") {
      return <div className="grid gap-3 lg:grid-cols-3">{months(3).map((m) => <MonthCalendar key={m} compact month={m} bookings={mine} today={today} onOpen={onOpen} onDay={(d) => onCreate(berth.id, d, d)} labelOf={(b) => b.title} />)}</div>;
    }
    const occupiedDays = new Set<string>();
    for (const b of mine) for (let d = b.startDate < view.from ? view.from : b.startDate; d <= b.endDate && d <= view.to; d = addDays(d, 1)) occupiedDays.add(d);
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink-muted"><b className="num font-semibold text-ink">{occupiedDays.size}</b> of <span className="num">{diffDays(view.from, view.to) + 1}</span> days occupied · {berth.name} {ft(berth.lengthFt)}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {months(12).map((m) => <MiniMonth key={m} month={m} bookings={mine} today={today} colorOf={() => "var(--harbor)"} onPick={() => toMonth(m)} />)}
        </div>
      </div>
    );
  }

  // ── all vessels ──
  if (lens === "vessels") {
    if (scale === "day") return <InPortToday bookings={bookings} day={date} onOpen={onOpen} onVessel={toVessel} />;
    if (scale === "year") return <VesselsYear bookings={bookings} from={view.from} to={view.to} onVessel={toVessel} />;
    const byVessel = new Map<string, BookingView[]>();
    for (const b of bookings) if (b.occupantType === "vessel" && b.vesselId) byVessel.set(b.vesselId, [...(byVessel.get(b.vesselId) ?? []), b]);
    const rows: TimelineRow[] = [...byVessel.entries()]
      .sort((a, b) => (a[1][0].startDate < b[1][0].startDate ? -1 : 1))
      .map(([id, bs]) => ({
        key: id, aria: `${bs[0].title}, ${bs[0].vesselLengthFt ?? "unknown"} feet`, bookings: bs,
        label: <button type="button" onClick={() => toVessel(id)} className="flex w-full min-w-0 items-baseline justify-between gap-2 py-1 text-left hover:text-harbor">
          <span className="truncate font-medium">{bs[0].title}</span><span className="num shrink-0 text-xs text-ink-muted">{ft(bs[0].vesselLengthFt)}</span></button>,
      }));
    if (state.nonVessel) {
      for (const berth of berths) {
        const other = bookings.filter((b) => b.berthId === berth.id && b.occupantType !== "vessel");
        if (other.length) rows.push({ key: `nv-${berth.id}`, berthId: berth.id, group: "Events & closures", aria: `${berth.name} events and closures`, bookings: other,
          label: <BerthLabel name={berth.name} lengthFt={berth.lengthFt} /> });
      }
    }
    return <Timeline rows={rows} from={view.from} to={view.to} today={today} occupancy={occ} barText={berthBar}
      onOpen={onOpen} onCreate={(id, s, e) => onCreate(id, s, e)} minColWidth={MIN_COL[scale]} rowNoun="Vessel" />;
  }

  // ── one vessel ──
  if (!entityId) return <Empty>Choose a vessel.</Empty>;
  if (scale === "day") return <VesselWhereabouts vesselId={entityId} day={date} onOpen={onOpen} />;
  const mine = bookings.filter((b) => b.vesselId === entityId);
  const colorOf = (b: BookingView) => colors.get(b.berthId) ?? "var(--harbor)";
  if (scale === "week") {
    return <Timeline rows={[{ key: entityId, aria: "Vessel", label: <span className="truncate font-medium">{mine[0]?.title ?? "This vessel"}</span>, bookings: mine }]}
      from={view.from} to={view.to} today={today} occupancy={occ} barText={berthBar} onOpen={onOpen} minColWidth={96} rowNoun="Vessel" />;
  }
  const newOnDay = (d: ISODate) => onCreate(undefined, d, d);
  if (scale === "month") return <MonthCalendar month={view.from} bookings={mine} today={today} onOpen={onOpen} onDay={newOnDay} colorOf={colorOf} labelOf={(b) => b.berthName} />;
  if (scale === "quarter") {
    return <div className="grid gap-3 lg:grid-cols-3">{months(3).map((m) => <MonthCalendar key={m} compact month={m} bookings={mine} today={today} onOpen={onOpen} onDay={newOnDay} colorOf={colorOf} labelOf={(b) => b.berthName} />)}</div>;
  }
  const perBerth = new Map<string, { name: string; days: number }>();
  for (const b of mine) {
    const s = b.startDate < view.from ? view.from : b.startDate, e = b.endDate > view.to ? view.to : b.endDate;
    const cur = perBerth.get(b.berthId) ?? { name: b.berthName, days: 0 };
    cur.days += diffDays(s, e) + 1; perBerth.set(b.berthId, cur);
  }
  const total = [...perBerth.values()].reduce((a, x) => a + x.days, 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="text-ink-muted"><b className="num font-semibold text-ink">{total}</b> days in port</span>
        {[...perBerth.entries()].map(([id, x]) => (
          <span key={id} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[2px]" style={{ background: colors.get(id) }} />{x.name} <span className="num text-ink-muted">{x.days}d</span></span>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {months(12).map((m) => <MiniMonth key={m} month={m} bookings={mine} today={today} colorOf={colorOf} onPick={() => toMonth(m)} />)}
      </div>
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string; hint?: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border bg-surface p-0.5">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} onClick={() => onChange(o.id)}
          title={o.hint ? `${o.label} (${o.hint})` : undefined}
          className={cn("rounded-md px-2.5 py-1 text-sm whitespace-nowrap transition-colors",
            value === o.id ? "bg-harbor text-primary-foreground" : "text-ink-muted hover:text-ink")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Filters({ state, set, berths }: { state: CalState; set: (p: Partial<CalState>) => void; berths: import("@shared/contract").Berth[] }) {
  const active = state.types.length < 3 || !!state.berths || state.nonVessel;
  const toggleType = (t: OccupantType) => {
    const next = state.types.includes(t) ? state.types.filter((x) => x !== t) : [...state.types, t];
    if (next.length) set({ types: next });
  };
  const chosen = new Set(state.berths ?? berths.map((b) => b.id));
  const toggleBerth = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id); else next.add(id);
    set({ berths: next.size === berths.length ? null : [...next] });
  };
  return (
    <Popover>
      <PopoverTrigger className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm", active ? "border-harbor/60 bg-harbor-soft" : "bg-surface hover:bg-muted")}>
        <SlidersHorizontal className="size-4" /> Filters{active && <span className="size-1.5 rounded-full bg-harbor" />}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-xs font-medium text-ink-muted">Show</legend>
          {TYPES.map((t) => (
            <label key={t} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={state.types.includes(t)} onChange={() => toggleType(t)} className="accent-[var(--harbor)]" />
              <OccupantIcon type={t} /> {occupantLabel[t]}s
            </label>
          ))}
        </fieldset>
        {state.lens === "vessels" && (
          <label className="flex items-center justify-between gap-2 text-sm">
            Also show events &amp; closures <Switch checked={state.nonVessel} onCheckedChange={(v) => set({ nonVessel: v })} />
          </label>
        )}
        <fieldset className="space-y-1 border-t pt-2">
          <legend className="mb-1 text-xs font-medium text-ink-muted">Berths</legend>
          <div className="max-h-44 space-y-1 overflow-y-auto">
            {berths.map((b) => (
              <label key={b.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={chosen.has(b.id)} onChange={() => toggleBerth(b.id)} className="accent-[var(--harbor)]" />
                <span className="flex-1 truncate">{b.name}</span><span className="num text-xs text-ink-muted">{ft(b.lengthFt)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {active && <Button variant="ghost" size="sm" onClick={() => set({ types: TYPES, berths: null, nonVessel: false })}>Reset filters</Button>}
      </PopoverContent>
    </Popover>
  );
}

function GridSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border bg-surface" aria-busy aria-label="Loading schedule">
      <div className="h-10 border-b bg-muted/40" />
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex h-9 items-center gap-3 border-b px-3 last:border-0">
          <div className="h-3 w-32 animate-pulse rounded bg-muted" />
          <div className="h-5 animate-pulse rounded bg-muted/70" style={{ marginLeft: `${(i * 37) % 40}%`, width: `${12 + ((i * 23) % 20)}%` }} />
        </div>
      ))}
    </div>
  );
}
