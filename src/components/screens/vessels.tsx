"use client";
// Vessels (frontend.md §3.5): search, create/edit, delete, and a fast lane for legacy vessels with no length.
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import type { Vessel, VesselInput } from "@shared/contract";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiRequestError, errorMessage } from "@/lib/api/client";
import { ft } from "@/lib/format";
import { useBookingEditor } from "@/components/booking/booking-editor";
import { useProjectCtx, useVessels } from "@/components/project/project-context";
import { ErrorBox, PageHeader } from "./page-header";

const PAGE_SIZE = 25;

export function VesselsScreen() {
  const { pid, api } = useProjectCtx();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [unknownOnly, setUnknownOnly] = useState(false);
  const [page, setPage] = useState(0);
  const list = useVessels(q.trim() || undefined, unknownOnly);
  const [editing, setEditing] = useState<Vessel | "new" | null>(null);
  const [deleting, setDeleting] = useState<Vessel | null>(null);
  const invalidate = () => { qc.invalidateQueries({ queryKey: [pid, "vessels"] }); qc.invalidateQueries({ queryKey: [pid, "schedule"] }); };

  const del = useMutation({
    mutationFn: (v: Vessel) => api.deleteVessel(v.id),
    onSuccess: (_x, v) => { invalidate(); toast.success(`Deleted ${v.name}.`); setDeleting(null); },
  });
  const all = list.data ?? [];
  // Paged here, not in the API: the booking form and the schedule's vessel picker need the whole list anyway.
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const at = Math.min(page, pages - 1);            // a delete can empty the last page
  const rows = all.slice(at * PAGE_SIZE, (at + 1) * PAGE_SIZE);
  const table = useRef<HTMLDivElement>(null);
  const goTo = (p: number) => {             // the pager sits under the table, so bring the new page's first row into view
    setPage(p);
    if (table.current && table.current.getBoundingClientRect().top < 0) table.current.scrollIntoView({ block: "start" });
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-3 sm:p-5">
      <PageHeader title="Vessels" sub="Name and length overall (LOA). Length decides which berths a vessel fits.">
        <Button onClick={() => setEditing("new")}><Plus /> New vessel</Button>
      </PageHeader>
      <div className="flex flex-wrap items-center gap-3">
        <Input placeholder="Search vessels" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} className="max-w-xs" aria-label="Search vessels" />
        <label className="flex items-center gap-2 text-sm">Length unknown <Switch checked={unknownOnly} onCheckedChange={(on) => { setUnknownOnly(on); setPage(0); }} /></label>
        {unknownOnly && <span className="text-xs text-ink-muted">Legacy vessels without a length can&rsquo;t be booked by hand. Type a length and press Enter; the next row gets focus.</span>}
      </div>
      {list.error ? <ErrorBox message={errorMessage(list.error)} onRetry={() => list.refetch()} /> : (
        <div ref={table} className="scroll-mt-16 overflow-x-auto rounded-xl border bg-surface">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b text-left text-[11px] tracking-wide text-ink-muted uppercase">
              <tr><th className="px-3 py-2 font-medium">Name</th><th className="px-3 py-2 font-medium">LOA</th><th className="px-3 py-2 font-medium">Draft</th><th className="px-3 py-2 font-medium">Operator</th><th className="w-24 px-3 py-2" /></tr>
            </thead>
            <tbody>
              {list.isLoading && Array.from({ length: 8 }, (_, i) => <tr key={i} className="border-b"><td colSpan={5} className="px-3 py-2.5"><div className="h-4 animate-pulse rounded bg-muted" /></td></tr>)}
              {rows.map((v, i) => (
                <tr key={v.id} className="border-b last:border-0 hover:bg-accent/60">
                  <td className="px-3 py-1.5 font-medium">{v.name}</td>
                  <td className="num px-3 py-1.5">{v.lengthFt == null ? <LengthCell vessel={v} rowIndex={i} /> : ft(v.lengthFt)}</td>
                  <td className="num px-3 py-1.5 text-ink-muted">{ft(v.draftFt)}</td>
                  <td className="px-3 py-1.5 text-ink-muted">{v.operator ?? "—"}</td>
                  <td className="px-3 py-1.5 text-right">
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit ${v.name}`} onClick={() => setEditing(v)}><Pencil /></Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete ${v.name}`} onClick={() => { del.reset(); setDeleting(v); }}><Trash2 /></Button>
                  </td>
                </tr>
              ))}
              {!list.isLoading && rows.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-10 text-center text-ink-muted">
                  {unknownOnly ? "Every vessel has a length. Nothing to fill in." : q ? `No vessel matches “${q}”.` : "No vessels yet — register the first one."}
                </td></tr>
              )}
            </tbody>
          </table>
          {all.length > 0 && (
            <div className="flex items-center justify-between gap-3 border-t px-3 py-1.5">
              <p className="num text-xs text-ink-muted">
                {pages > 1 ? `${at * PAGE_SIZE + 1}–${at * PAGE_SIZE + rows.length} of ` : ""}{all.length} vessel{all.length === 1 ? "" : "s"}
              </p>
              {pages > 1 && (
                <nav aria-label="Vessel pages" className="flex items-center gap-1">
                  <Button variant="ghost" size="icon-sm" aria-label="Previous page" disabled={at === 0} onClick={() => goTo(at - 1)}><ChevronLeft /></Button>
                  <span className="num min-w-14 text-center text-xs text-ink-muted" aria-live="polite">{at + 1} / {pages}</span>
                  <Button variant="ghost" size="icon-sm" aria-label="Next page" disabled={at === pages - 1} onClick={() => goTo(at + 1)}><ChevronRight /></Button>
                </nav>
              )}
            </div>
          )}
        </div>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        {editing && <VesselForm key={editing === "new" ? "new" : editing.id} vessel={editing === "new" ? null : editing} onDone={() => { invalidate(); setEditing(null); }} />}
      </Dialog>
      <Dialog open={!!deleting} onOpenChange={(o) => { if (!o) setDeleting(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {deleting?.name}?</DialogTitle>
            <DialogDescription>Only possible when no booking — confirmed or cancelled — refers to it.</DialogDescription>
          </DialogHeader>
          {del.error && <p className="rounded-md border border-signal/40 bg-signal-soft px-3 py-2 text-sm">{errorMessage(del.error)}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>Keep it</Button>
            <Button variant="destructive" disabled={del.isPending || !!del.error} onClick={() => deleting && del.mutate(deleting)}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Inline length entry for legacy vessels; Enter saves and moves to the next row. */
function LengthCell({ vessel, rowIndex }: { vessel: Vessel; rowIndex: number }) {
  const { pid, api } = useProjectCtx();
  const qc = useQueryClient();
  const [v, setV] = useState("");
  const save = useMutation({
    mutationFn: () => api.updateVessel(vessel.id, { lengthFt: Number(v) }),
    onSuccess: () => {
      toast.success(`${vessel.name}: ${ft(Number(v))}`);
      // after the refetch, move focus to the next vessel still missing a length
      qc.invalidateQueries({ queryKey: [pid, "vessels"] }).then(() => {
        const next = [...document.querySelectorAll<HTMLInputElement>("[data-length-row]")]
          .find((el) => Number(el.dataset.lengthRow) >= rowIndex && el !== document.activeElement);
        next?.focus();
      });
    },
  });
  return (
    <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (Number(v) > 0) save.mutate(); }}>
      <Input data-length-row={rowIndex} aria-label={`Length of ${vessel.name} in feet`} placeholder="ft" inputMode="decimal" value={v}
        onChange={(e) => setV(e.target.value)} className="num h-7 w-20 border-dashed" />
      {save.error && <span className="text-xs text-signal">{errorMessage(save.error)}</span>}
    </form>
  );
}

function VesselForm({ vessel, onDone }: { vessel: Vessel | null; onDone: () => void }) {
  const { api } = useProjectCtx();
  const editor = useBookingEditor();
  const [f, setF] = useState({ name: vessel?.name ?? "", lengthFt: vessel?.lengthFt?.toString() ?? "", draftFt: vessel?.draftFt?.toString() ?? "", operator: vessel?.operator ?? "", notes: vessel?.notes ?? "" });
  const save = useMutation({
    mutationFn: () => {
      const body: VesselInput = { name: f.name.trim(), lengthFt: Number(f.lengthFt), draftFt: f.draftFt ? Number(f.draftFt) : null, operator: f.operator.trim() || null, notes: f.notes.trim() || null };
      return vessel ? api.updateVessel(vessel.id, body) : api.createVessel(body);
    },
    onSuccess: (v) => { toast.success(`${vessel ? "Saved" : "Registered"} ${v.name}.`); onDone(); },
  });
  const broken = save.error instanceof ApiRequestError ? save.error.body.error.violations?.flatMap((x) => x.bookingIds ?? []) ?? [] : [];
  const valid = f.name.trim() && Number(f.lengthFt) > 0 && (!f.draftFt || Number(f.draftFt) > 0);
  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>{vessel ? `Edit ${vessel.name}` : "New vessel"}</DialogTitle></DialogHeader>
      <form id="vessel-form" className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
        <div className="space-y-1.5"><Label htmlFor="vf-n">Name</Label><Input id="vf-n" autoFocus placeholder="R/V Tern" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label htmlFor="vf-l">LOA (ft)</Label><Input id="vf-l" inputMode="decimal" className="num" value={f.lengthFt} onChange={(e) => setF({ ...f, lengthFt: e.target.value })} /></div>
          <div className="space-y-1.5"><Label htmlFor="vf-d">Draft (ft)</Label><Input id="vf-d" inputMode="decimal" className="num" value={f.draftFt} onChange={(e) => setF({ ...f, draftFt: e.target.value })} /></div>
        </div>
        <div className="space-y-1.5"><Label htmlFor="vf-o">Operator</Label><Input id="vf-o" value={f.operator} onChange={(e) => setF({ ...f, operator: e.target.value })} /></div>
        <div className="space-y-1.5"><Label htmlFor="vf-x">Notes</Label><Textarea id="vf-x" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
        {save.error && (
          <div className="rounded-md border border-signal/40 bg-signal-soft px-3 py-2 text-sm">
            <p>{errorMessage(save.error)}</p>
            {broken.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {broken.slice(0, 8).map((id, i) => <button key={id} type="button" onClick={() => editor.openDetail(id)} className="rounded border border-signal/40 bg-surface px-1.5 py-0.5 text-xs">Booking {i + 1} →</button>)}
              </div>
            )}
          </div>
        )}
      </form>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" form="vessel-form" disabled={!valid || save.isPending}>{vessel ? "Save" : "Register"}</Button>
      </DialogFooter>
    </DialogContent>
  );
}
