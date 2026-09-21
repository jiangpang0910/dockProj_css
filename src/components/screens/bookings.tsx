"use client";
// Bookings list (frontend.md §3.4): filterable table, filters in the URL, row → detail drawer.
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { MAX_WINDOW_DAYS, type OccupantType } from "@shared/contract";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { diffDays, endOfMonth, formatRange, isISODate, spanDays, startOfMonth } from "@/lib/dates";
import { ft, occupantLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { OccupantIcon } from "@/components/booking/occupant";
import { useBookingEditor } from "@/components/booking/booking-editor";
import { useBerths, useProjectCtx, useToday } from "@/components/project/project-context";
import { ErrorBox, PageHeader } from "./page-header";

export function BookingsScreen() {
  const { pid, api } = useProjectCtx();
  const router = useRouter(), pathname = usePathname(), params = useSearchParams();
  const today = useToday();
  const editor = useBookingEditor();
  const berths = useBerths(true);

  const from = params.get("from") ?? (today ? startOfMonth(today) : "");
  const to = params.get("to") ?? (today ? endOfMonth(today) : "");
  const berthId = params.get("berthId") ?? "";
  const type = (params.get("type") ?? "") as OccupantType | "";
  const includeCancelled = params.get("cancelled") === "1";
  const qParam = params.get("q") ?? "";
  const [q, setQ] = useState(qParam);
  const set = (patch: Record<string, string>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    router.replace(`${pathname}?${p}`, { scroll: false });
  };
  useEffect(() => { const t = setTimeout(() => { if (q !== qParam) set({ q }); }, 250); return () => clearTimeout(t); }, [q, qParam]); // eslint-disable-line react-hooks/exhaustive-deps

  const windowOk = isISODate(from) && isISODate(to) && to >= from && diffDays(from, to) + 1 <= MAX_WINDOW_DAYS;
  const filter = { from, to, berthId: berthId || undefined, occupantType: type || undefined, q: qParam || undefined, includeCancelled: includeCancelled || undefined };
  const res = useQuery({ queryKey: qk.bookings(pid, filter), queryFn: () => api.listBookings(filter), enabled: windowOk, placeholderData: (p) => p });
  const rows = res.data ?? [];

  return (
    <div className="space-y-5 p-3 sm:p-5">
      <PageHeader title="Bookings" sub="Every booking that touches the date range." />
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-surface p-4">
        <div className="space-y-1.5"><Label htmlFor="bl-f">From</Label><Input id="bl-f" type="date" className="num w-40" value={from} onChange={(e) => set({ from: e.target.value })} /></div>
        <div className="space-y-1.5"><Label htmlFor="bl-t">To</Label><Input id="bl-t" type="date" className="num w-40" value={to} min={from} onChange={(e) => set({ to: e.target.value })} /></div>
        <div className="space-y-1.5"><Label htmlFor="bl-b">Berth</Label>
          <select id="bl-b" value={berthId} onChange={(e) => set({ berthId: e.target.value })} className="h-8 rounded-lg border border-input bg-surface px-2 text-sm">
            <option value="">All berths</option>
            {berths.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select></div>
        <div className="space-y-1.5"><Label htmlFor="bl-y">Type</Label>
          <select id="bl-y" value={type} onChange={(e) => set({ type: e.target.value })} className="h-8 rounded-lg border border-input bg-surface px-2 text-sm">
            <option value="">All types</option>
            {(["vessel", "event", "closure"] as const).map((t) => <option key={t} value={t}>{occupantLabel[t]}</option>)}
          </select></div>
        <div className="min-w-48 flex-1 space-y-1.5"><Label htmlFor="bl-q">Search</Label><Input id="bl-q" placeholder="Vessel or event name" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <label className="flex h-8 items-center gap-2 text-sm">Include cancelled <Switch checked={includeCancelled} onCheckedChange={(v) => set({ cancelled: v ? "1" : "" })} /></label>
      </div>
      {!windowOk ? <p className="text-sm text-signal">Choose a range of at most {MAX_WINDOW_DAYS} days, with From before To.</p> :
       res.error ? <ErrorBox message={errorMessage(res.error)} onRetry={() => res.refetch()} /> : (
        <div className="overflow-x-auto rounded-xl border bg-surface">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b text-left text-[11px] tracking-wide text-ink-muted uppercase">
              <tr>{["Dates", "Days", "Berth", "Occupant", "Type", "Status", "Source"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {res.isLoading && Array.from({ length: 6 }, (_, i) => <tr key={i} className="border-b"><td colSpan={7} className="px-3 py-2.5"><div className="h-4 animate-pulse rounded bg-muted" /></td></tr>)}
              {rows.map((b) => (
                <tr key={b.id} tabIndex={0} onClick={() => editor.openDetail(b.id)} onKeyDown={(e) => { if (e.key === "Enter") editor.openDetail(b.id); }}
                  className={cn("cursor-pointer border-b last:border-0 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none", b.status === "cancelled" && "text-ink-muted")}>
                  <td className="num px-3 py-2 whitespace-nowrap">{formatRange(b.startDate, b.endDate)}</td>
                  <td className="num px-3 py-2">{spanDays(b.startDate, b.endDate)}</td>
                  <td className="px-3 py-2">{b.berthName} <span className="num text-xs text-ink-muted">{b.berthLengthFt == null ? "shared" : ft(b.berthLengthFt)}</span></td>
                  <td className="px-3 py-2 font-medium">{b.title}{b.occupantType === "vessel" && <span className="num ml-1.5 text-xs font-normal text-ink-muted">{ft(b.vesselLengthFt)}</span>}</td>
                  <td className="px-3 py-2"><span className="inline-flex items-center gap-1.5"><OccupantIcon type={b.occupantType} />{occupantLabel[b.occupantType]}</span></td>
                  <td className="px-3 py-2">{b.status === "cancelled" ? <span className="rounded bg-muted px-1.5 text-xs">cancelled</span> : "confirmed"}</td>
                  <td className="px-3 py-2 text-ink-muted">{b.source}</td>
                </tr>
              ))}
              {!res.isLoading && rows.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-10 text-center text-ink-muted">
                  No bookings match. <button type="button" className="text-harbor hover:underline" onClick={() => editor.openNew({ startDate: from, endDate: from })}>Create one</button>
                </td></tr>
              )}
            </tbody>
          </table>
          {rows.length > 0 && <p className="num border-t px-3 py-2 text-xs text-ink-muted">{rows.length} booking{rows.length === 1 ? "" : "s"}</p>}
        </div>
      )}
    </div>
  );
}
