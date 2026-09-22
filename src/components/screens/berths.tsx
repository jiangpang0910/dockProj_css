"use client";
// Berths (frontend.md §3.6): short list, active toggle, utilization this month, create/edit, delete → deactivate.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import type { Berth } from "@shared/contract";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ApiRequestError, errorMessage } from "@/lib/api/client";
import { qk } from "@/lib/api/keys";
import { addDays, diffDays, endOfMonth, monthLabel, startOfMonth } from "@/lib/dates";
import { ft } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useBookingEditor } from "@/components/booking/booking-editor";
import { useBerths, useProjectCtx, useToday } from "@/components/project/project-context";
import { clip } from "@/components/calendar/model";
import { ErrorBox, PageHeader } from "./page-header";

export function BerthsScreen() {
  const { pid, api } = useProjectCtx();
  const qc = useQueryClient();
  const today = useToday();
  const list = useBerths(true);
  const from = today ? startOfMonth(today) : "", to = today ? endOfMonth(today) : "";
  const sched = useQuery({ queryKey: qk.schedule(pid, from, to), queryFn: () => api.getSchedule(from, to), enabled: !!today });
  const [editing, setEditing] = useState<Berth | "new" | null>(null);
  const [deleting, setDeleting] = useState<Berth | null>(null);
  const invalidate = () => { qc.invalidateQueries({ queryKey: [pid, "berths"] }); qc.invalidateQueries({ queryKey: [pid, "schedule"] }); qc.invalidateQueries({ queryKey: qk.project(pid) }); };

  const util = useMemo(() => {
    const m = new Map<string, number>();
    if (!sched.data) return m;
    const days = diffDays(from, to) + 1;
    for (const berth of sched.data.berths) {
      const set = new Set<string>();
      for (const b of sched.data.bookings) {
        if (b.berthId !== berth.id) continue;
        const c = clip(b, from, to); if (!c) continue;
        for (let d = c.s; d <= c.e; d = addDays(d, 1)) set.add(d);
      }
      m.set(berth.id, set.size / days);
    }
    return m;
  }, [sched.data, from, to]);

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Berth> }) => api.updateBerth(id, body),
    onSuccess: invalidate,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const del = useMutation({
    mutationFn: (b: Berth) => api.deleteBerth(b.id),
    onSuccess: (_x, b) => { invalidate(); toast.success(`Deleted ${b.name}.`); setDeleting(null); },
  });
  const rows = (list.data ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const move = (i: number, dir: -1 | 1) => {
    const a = rows[i], b = rows[i + dir]; if (!a || !b) return;
    patch.mutate({ id: a.id, body: { sortOrder: b.sortOrder } });
    patch.mutate({ id: b.id, body: { sortOrder: a.sortOrder } });
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-3 sm:p-5">
      <PageHeader title="Berths" sub={<>A berth holds one occupant a day. Its length is what the fit check uses; until it&rsquo;s on record, bookings here can&rsquo;t be checked for fit.</>}>
        <Button onClick={() => setEditing("new")}><Plus /> New berth</Button>
      </PageHeader>
      {list.error ? <ErrorBox message={errorMessage(list.error)} onRetry={() => list.refetch()} /> : (
        <div className="overflow-x-auto rounded-xl border bg-surface">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b text-left text-[11px] tracking-wide text-ink-muted uppercase">
              <tr><th className="w-16 px-3 py-2 font-medium">Order</th><th className="px-3 py-2 font-medium">Name</th><th className="px-3 py-2 font-medium">Length</th>
                <th className="px-3 py-2 font-medium">{today ? monthLabel(today) : "This month"}</th><th className="px-3 py-2 font-medium">Active</th><th className="w-24 px-3 py-2" /></tr>
            </thead>
            <tbody>
              {list.isLoading && Array.from({ length: 8 }, (_, i) => <tr key={i} className="border-b"><td colSpan={6} className="px-3 py-3"><div className="h-4 animate-pulse rounded bg-muted" /></td></tr>)}
              {rows.map((b, i) => {
                const u = util.get(b.id);
                return (
                  <tr key={b.id} className={cn("border-b last:border-0", !b.active && "text-ink-muted")}>
                    <td className="px-2 py-1.5">
                      <div className="flex">
                        <Button variant="ghost" size="icon-xs" aria-label={`Move ${b.name} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>
                        <Button variant="ghost" size="icon-xs" aria-label={`Move ${b.name} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 font-medium">{b.name}</td>
                    <td className="num px-3 py-1.5">{b.lengthFt == null ? <span className="text-brass">not on record</span> : ft(b.lengthFt)}</td>
                    <td className="px-3 py-1.5">
                      {u == null ? <span className="text-ink-muted">—</span> : (
                        <span className="flex items-center gap-2">
                          <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted"><span className="block h-full bg-harbor" style={{ width: `${u * 100}%` }} /></span>
                          <span className="num text-xs text-ink-muted">{Math.round(u * 100)}%</span>
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5"><Switch aria-label={`${b.name} active`} checked={b.active} onCheckedChange={(v) => patch.mutate({ id: b.id, body: { active: v } })} /></td>
                    <td className="px-3 py-1.5 text-right">
                      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${b.name}`} onClick={() => setEditing(b)}><Pencil /></Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${b.name}`} onClick={() => { del.reset(); setDeleting(b); }}><Trash2 /></Button>
                    </td>
                  </tr>
                );
              })}
              {!list.isLoading && rows.length === 0 && <tr><td colSpan={6} className="px-3 py-10 text-center text-ink-muted">No berths yet. Add the first one, or upload a spreadsheet on the Import page.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-ink-muted">Inactive berths take no new bookings; their existing bookings stay put.</p>

      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        {editing && <BerthForm key={editing === "new" ? "new" : editing.id} berth={editing === "new" ? null : editing} onDone={() => { invalidate(); setEditing(null); }} onCancel={() => setEditing(null)} />}
      </Dialog>
      <Dialog open={!!deleting} onOpenChange={(o) => { if (!o) setDeleting(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {deleting?.name}?</DialogTitle>
            <DialogDescription>Only possible when no booking refers to it. A berth with history can be deactivated instead.</DialogDescription>
          </DialogHeader>
          {del.error && <p className="rounded-md border border-signal/40 bg-signal-soft px-3 py-2 text-sm">{errorMessage(del.error)}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>Keep it</Button>
            {del.error instanceof ApiRequestError && del.error.status === 409 && deleting?.active ? (
              <Button onClick={() => { patch.mutate({ id: deleting.id, body: { active: false } }); toast.success(`${deleting.name} deactivated.`); setDeleting(null); }}>Deactivate instead</Button>
            ) : (
              <Button variant="destructive" disabled={del.isPending || !!del.error} onClick={() => deleting && del.mutate(deleting)}>Delete</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BerthForm({ berth, onDone, onCancel }: { berth: Berth | null; onDone: () => void; onCancel: () => void }) {
  const { api } = useProjectCtx();
  const editor = useBookingEditor();
  const [name, setName] = useState(berth?.name ?? "");
  const [len, setLen] = useState(berth?.lengthFt?.toString() ?? "");
  const save = useMutation({
    mutationFn: () => berth
      ? api.updateBerth(berth.id, { name: name.trim(), lengthFt: len.trim() ? Number(len) : null })
      : api.createBerth({ name: name.trim(), lengthFt: len.trim() ? Number(len) : null }),
    onSuccess: (b) => { toast.success(`${berth ? "Saved" : "Added"} ${b.name}.`); onDone(); },
  });
  const broken = save.error instanceof ApiRequestError ? save.error.body.error.violations?.flatMap((x) => x.bookingIds ?? []) ?? [] : [];
  const valid = name.trim() && (!len.trim() || Number(len) > 0);
  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>{berth ? `Edit ${berth.name}` : "New berth"}</DialogTitle></DialogHeader>
      <form id="berth-form" className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
        <div className="space-y-1.5"><Label htmlFor="bf-n">Name</Label><Input id="bf-n" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="South Float West" /></div>
        <div className="space-y-1.5">
          <Label htmlFor="bf-l">Length (ft)</Label>
          <Input id="bf-l" inputMode="decimal" className="num" value={len} onChange={(e) => setLen(e.target.value)} placeholder="not on record" />
          <p className="text-xs text-ink-muted">Leave it blank if you don&rsquo;t know it. Nothing booked here can be checked for fit until it&rsquo;s filled in.</p>
        </div>
        {save.error && (
          <div className="rounded-md border border-signal/40 bg-signal-soft px-3 py-2 text-sm">
            <p>{errorMessage(save.error)}</p>
            {broken.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{broken.slice(0, 8).map((id, i) => <button key={id} type="button" onClick={() => editor.openDetail(id)} className="rounded border border-signal/40 bg-surface px-1.5 py-0.5 text-xs">Booking {i + 1} →</button>)}</div>}
          </div>
        )}
      </form>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" form="berth-form" disabled={!valid || save.isPending}>{berth ? "Save" : "Add berth"}</Button>
      </DialogFooter>
    </DialogContent>
  );
}
