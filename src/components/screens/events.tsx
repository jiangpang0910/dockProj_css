"use client";
// Events: the non-vessel bookings (community sail days, campus events) and, if asked for, closures.
// Same data as /bookings, narrowed to one occupant type and grouped into upcoming and past.
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Flag, Plus } from "lucide-react";
import { MAX_WINDOW_DAYS, type BookingView } from "@shared/contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { addDays, addYears, diffDays, formatRange, isISODate, spanDays, startOfMonth } from "@/lib/dates";
import { occupantLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { OccupantIcon } from "@/components/booking/occupant";
import { useBookingEditor } from "@/components/booking/booking-editor";
import { useBerths, useProjectCtx, useToday } from "@/components/project/project-context";
import { ErrorBox, PageHeader } from "./page-header";

export function EventsScreen() {
  const { pid, api } = useProjectCtx();
  const router = useRouter(), pathname = usePathname(), params = useSearchParams();
  const today = useToday();
  const editor = useBookingEditor();
  const berths = useBerths(true);

  // A year of the calendar by default: events are sparse, and a month at a time hides most of them.
  const from = params.get("from") ?? (today ? startOfMonth(today) : "");
  const to = params.get("to") ?? (from ? addDays(addYears(from, 1), -1) : "");
  const withClosures = params.get("closures") === "1";
  const berthId = params.get("berthId") ?? "";
  const qParam = params.get("q") ?? "";
  const [q, setQ] = useState(qParam);
  const set = (patch: Record<string, string>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    router.replace(`${pathname}?${p}`, { scroll: false });
  };
  useEffect(() => { const t = setTimeout(() => { if (q !== qParam) set({ q }); }, 250); return () => clearTimeout(t); }, [q, qParam]); // eslint-disable-line react-hooks/exhaustive-deps

  const windowOk = isISODate(from) && isISODate(to) && to >= from && diffDays(from, to) + 1 <= MAX_WINDOW_DAYS;
  // One request either way: closures come back with the events and are filtered out here when not wanted.
  const filter = { from, to, berthId: berthId || undefined, q: qParam || undefined };
  const res = useQuery({
    queryKey: qk.bookings(pid, { ...filter, screen: "events", closures: withClosures }),
    queryFn: async () => {
      const kinds = withClosures ? (["event", "closure"] as const) : (["event"] as const);
      const lists = await Promise.all(kinds.map((occupantType) => api.listBookings({ ...filter, occupantType })));
      return lists.flat().sort((a, b) => a.startDate.localeCompare(b.startDate) || a.title.localeCompare(b.title));
    },
    enabled: windowOk,
    placeholderData: (p) => p,
  });
  const rows = res.data ?? [];
  const live = rows.filter((b) => b.status !== "cancelled");
  const upcoming = today ? live.filter((b) => b.endDate >= today) : live;
  const past = today ? live.filter((b) => b.endDate < today) : [];
  const days = upcoming.reduce((n, b) => n + spanDays(b.startDate, b.endDate), 0);

  return (
    <div className="space-y-5 p-3 sm:p-5">
      <PageHeader title="Events" sub="Everything on a berth that isn't a vessel: sail days, campus events, and the closures that keep a berth empty.">
        <Button size="sm" className="gap-1.5" onClick={() => editor.openNew({ occupantType: "event", startDate: today ?? undefined, endDate: today ?? undefined })}>
          <Plus /> New event
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-surface p-4">
        <div className="space-y-1.5"><Label htmlFor="ev-f">From</Label><Input id="ev-f" type="date" className="num w-40" value={from} onChange={(e) => set({ from: e.target.value })} /></div>
        <div className="space-y-1.5"><Label htmlFor="ev-t">To</Label><Input id="ev-t" type="date" className="num w-40" value={to} min={from} onChange={(e) => set({ to: e.target.value })} /></div>
        <div className="space-y-1.5"><Label htmlFor="ev-b">Berth</Label>
          <select id="ev-b" value={berthId} onChange={(e) => set({ berthId: e.target.value })} className="h-8 rounded-lg border border-input bg-surface px-2 text-sm">
            <option value="">All berths</option>
            {berths.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select></div>
        <div className="min-w-48 flex-1 space-y-1.5"><Label htmlFor="ev-q">Search</Label><Input id="ev-q" placeholder="Event name" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="flex h-8 items-center gap-1 rounded-lg border p-0.5 text-sm">
          {([["Events", false], ["With closures", true]] as const).map(([label, on]) => (
            <button key={label} type="button" onClick={() => set({ closures: on ? "1" : "" })}
              aria-pressed={withClosures === on}
              className={cn("rounded-md px-2.5 py-1 text-xs transition-colors",
                withClosures === on ? "bg-harbor-soft font-medium text-ink" : "text-ink-muted hover:text-ink")}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {!windowOk ? <p className="text-sm text-signal">Choose a range of at most {MAX_WINDOW_DAYS} days, with From before To.</p> :
       res.error ? <ErrorBox message={errorMessage(res.error)} onRetry={() => res.refetch()} /> : (
        <div className="space-y-5">
          <Table title="Upcoming" count={upcoming.length} rows={upcoming} loading={res.isLoading}
            sub={days ? `${days} day${days === 1 ? "" : "s"} of berth time` : undefined}
            empty={<>Nothing booked in this range. <button type="button" className="text-harbor hover:underline"
              onClick={() => editor.openNew({ occupantType: "event", startDate: from, endDate: from })}>Add an event</button></>} />
          {past.length > 0 && <Table title="Past" count={past.length} rows={past} loading={false} muted />}
        </div>
      )}
    </div>
  );
}

function Table({ title, sub, count, rows, loading, empty, muted }: {
  title: string; sub?: string; count: number; rows: BookingView[]; loading: boolean; empty?: React.ReactNode; muted?: boolean;
}) {
  const editor = useBookingEditor();
  return (
    <section className="space-y-2">
      <h2 className="flex items-baseline gap-2 text-sm font-medium">
        {title} <span className="num text-xs text-ink-muted">{count}</span>
        {sub && <span className="text-xs font-normal text-ink-muted">· {sub}</span>}
      </h2>
      <div className={cn("overflow-x-auto rounded-xl border bg-surface", muted && "opacity-75")}>
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b text-left text-[11px] tracking-wide text-ink-muted uppercase">
            <tr>{["Dates", "Days", "Event", "Berth", "Type", "Source"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {loading && Array.from({ length: 4 }, (_, i) => <tr key={i} className="border-b"><td colSpan={6} className="px-3 py-2.5"><div className="h-4 animate-pulse rounded bg-muted" /></td></tr>)}
            {rows.map((b) => (
              <tr key={b.id} tabIndex={0} onClick={() => editor.openDetail(b.id)} onKeyDown={(e) => { if (e.key === "Enter") editor.openDetail(b.id); }}
                className="cursor-pointer border-b last:border-0 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
                <td className="num px-3 py-2 whitespace-nowrap">{formatRange(b.startDate, b.endDate)}</td>
                <td className="num px-3 py-2">{spanDays(b.startDate, b.endDate)}</td>
                <td className="px-3 py-2 font-medium">{b.title}</td>
                <td className="px-3 py-2">{b.berthName} <span className="num text-xs text-ink-muted">{b.berthLengthFt == null ? "shared" : `${b.berthLengthFt}′`}</span></td>
                <td className="px-3 py-2"><span className="inline-flex items-center gap-1.5"><OccupantIcon type={b.occupantType} />{occupantLabel[b.occupantType]}</span></td>
                <td className="px-3 py-2 text-ink-muted">{b.source}</td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-10 text-center text-ink-muted">
                <Flag aria-hidden className="mx-auto mb-2 size-5 opacity-50" />{empty}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
