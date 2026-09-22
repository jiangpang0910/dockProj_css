"use client";
// Tours (the workbook's Tours tab): guided visits aboard vessels. They hold no berth, so they live beside the
// events rather than on the schedule. Add, edit and delete; the vessel is free text matched by name.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Compass, Pencil, Plus, Trash2 } from "lucide-react";
import { DATE_MAX, DATE_MIN, type Tour, type TourInput } from "@shared/contract";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { formatDay, isISODate } from "@/lib/dates";
import { useProjectCtx, useToday } from "@/components/project/project-context";
import { ErrorBox } from "./page-header";

export function ToursSection() {
  const { pid, api } = useProjectCtx();
  const qc = useQueryClient();
  const today = useToday();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Tour | "new" | null>(null);
  const [deleting, setDeleting] = useState<Tour | null>(null);
  const list = useQuery({ queryKey: qk.tours(pid), queryFn: () => api.listTours(), staleTime: 60_000 });
  const invalidate = () => qc.invalidateQueries({ queryKey: [pid, "tours"] });
  const del = useMutation({
    mutationFn: (t: Tour) => api.deleteTour(t.id),
    onSuccess: () => { invalidate(); toast.success("Tour removed."); setDeleting(null); },
  });
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data ?? []).filter((t) => !needle || [t.guide, t.guest, t.vesselName, t.notes].some((s) => s?.toLowerCase().includes(needle)));
  }, [list.data, q]);

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex items-baseline gap-2 text-sm font-medium">
          Tours <span className="num text-xs text-ink-muted">{rows.length}</span>
          <span className="text-xs font-normal text-ink-muted">· guided visits aboard a vessel; they don&rsquo;t hold a berth</span>
        </h2>
        <div className="ml-auto flex items-center gap-2">
          <Input placeholder="Search tours" aria-label="Search tours" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 w-44" />
          <Button size="sm" variant="outline" onClick={() => setEditing("new")}><Plus /> New tour</Button>
        </div>
      </div>
      {list.error ? <ErrorBox message={errorMessage(list.error)} onRetry={() => list.refetch()} /> : (
        <div className="overflow-x-auto rounded-xl border bg-surface">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b text-left text-[11px] tracking-wide text-ink-muted uppercase">
              <tr>{["Date", "Time", "Vessel", "Guide", "Guest", "People", "Notes", ""].map((h, i) => <th key={i} className="px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody>
              {list.isLoading && Array.from({ length: 3 }, (_, i) => <tr key={i} className="border-b"><td colSpan={8} className="px-3 py-2.5"><div className="h-4 animate-pulse rounded bg-muted" /></td></tr>)}
              {rows.map((t) => (
                <tr key={t.id} className="border-b last:border-0 hover:bg-accent/60">
                  <td className="num px-3 py-1.5 whitespace-nowrap">{formatDay(t.date)}</td>
                  <td className="num px-3 py-1.5">{t.time ?? "—"}</td>
                  <td className="px-3 py-1.5 font-medium">{t.vesselName ?? "—"}</td>
                  <td className="px-3 py-1.5">{t.guide ?? "—"}</td>
                  <td className="px-3 py-1.5">{t.guest ?? "—"}</td>
                  <td className="num px-3 py-1.5">{t.people ?? "—"}</td>
                  <td className="max-w-64 truncate px-3 py-1.5 text-ink-muted" title={t.notes ?? undefined}>{t.notes ?? ""}</td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    <Button variant="ghost" size="icon-sm" aria-label="Edit tour" onClick={() => setEditing(t)}><Pencil /></Button>
                    <Button variant="ghost" size="icon-sm" aria-label="Delete tour" onClick={() => { del.reset(); setDeleting(t); }}><Trash2 /></Button>
                  </td>
                </tr>
              ))}
              {!list.isLoading && rows.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-ink-muted">
                  <Compass aria-hidden className="mx-auto mb-2 size-5 opacity-50" />{q ? `No tour matches “${q}”.` : "No tours on record."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        {editing && <TourForm key={editing === "new" ? "new" : editing.id} tour={editing === "new" ? null : editing} defaultDate={today} onDone={() => { invalidate(); setEditing(null); }} />}
      </Dialog>
      <Dialog open={!!deleting} onOpenChange={(o) => { if (!o) setDeleting(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove this tour?</DialogTitle>
            <DialogDescription>{deleting && `${formatDay(deleting.date)}${deleting.vesselName ? ` · ${deleting.vesselName}` : ""}`}</DialogDescription>
          </DialogHeader>
          {del.error && <p className="rounded-md border border-signal/40 bg-signal-soft px-3 py-2 text-sm">{errorMessage(del.error)}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>Keep it</Button>
            <Button variant="destructive" disabled={del.isPending} onClick={() => deleting && del.mutate(deleting)}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function TourForm({ tour, defaultDate, onDone }: { tour: Tour | null; defaultDate?: string; onDone: () => void }) {
  const { api } = useProjectCtx();
  const [f, setF] = useState({
    date: tour?.date ?? defaultDate ?? "", time: tour?.time ?? "", vesselName: tour?.vesselName ?? "", guide: tour?.guide ?? "",
    guest: tour?.guest ?? "", people: tour?.people?.toString() ?? "", notes: tour?.notes ?? "",
  });
  const save = useMutation({
    mutationFn: () => {
      const body: TourInput = { date: f.date, time: f.time.trim() || null, vesselName: f.vesselName.trim() || null, guide: f.guide.trim() || null,
        guest: f.guest.trim() || null, people: f.people.trim() ? Number(f.people) : null, notes: f.notes.trim() || null };
      return tour ? api.updateTour(tour.id, body) : api.createTour(body);
    },
    onSuccess: () => { toast.success(tour ? "Tour saved." : "Tour added."); onDone(); },
  });
  const valid = isISODate(f.date) && (!f.people.trim() || Number.isInteger(Number(f.people)) && Number(f.people) >= 0);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>{tour ? "Edit tour" : "New tour"}</DialogTitle></DialogHeader>
      <form id="tour-form" className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label htmlFor="tf-d">Date</Label><Input id="tf-d" type="date" min={DATE_MIN} max={DATE_MAX} className="num" value={f.date} onChange={set("date")} autoFocus /></div>
          <div className="space-y-1.5"><Label htmlFor="tf-t">Time</Label><Input id="tf-t" placeholder="15:30 or tbd" className="num" value={f.time} onChange={set("time")} /></div>
        </div>
        <div className="space-y-1.5"><Label htmlFor="tf-v">Vessel</Label><Input id="tf-v" placeholder="R/V Silver Tern" value={f.vesselName} onChange={set("vesselName")} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label htmlFor="tf-g">Guide</Label><Input id="tf-g" value={f.guide} onChange={set("guide")} /></div>
          <div className="space-y-1.5"><Label htmlFor="tf-p">People</Label><Input id="tf-p" inputMode="numeric" className="num" value={f.people} onChange={set("people")} /></div>
        </div>
        <div className="space-y-1.5"><Label htmlFor="tf-u">Guest</Label><Input id="tf-u" placeholder="Name (organisation)" value={f.guest} onChange={set("guest")} /></div>
        <div className="space-y-1.5"><Label htmlFor="tf-n">Notes</Label><Textarea id="tf-n" rows={2} value={f.notes} onChange={set("notes")} /></div>
        {save.error && <p className="rounded-md border border-signal/40 bg-signal-soft px-3 py-2 text-sm">{errorMessage(save.error)}</p>}
      </form>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" form="tour-form" disabled={!valid || save.isPending}>{tour ? "Save" : "Add"}</Button>
      </DialogFooter>
    </DialogContent>
  );
}
