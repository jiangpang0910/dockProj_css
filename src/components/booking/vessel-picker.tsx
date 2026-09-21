"use client";
// Vessel combobox: search as you type, LOA beside every name, "Register new vessel" inline (frontend.md §3.2).
import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Ship } from "lucide-react";
import type { Vessel } from "@shared/contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/client";
import { ft } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useProjectCtx, useVessels } from "@/components/project/project-context";

export function VesselPicker({ value, onChange, invalid }: { value: string | null | undefined; onChange: (v: Vessel) => void; invalid?: boolean }) {
  const { pid, api } = useProjectCtx();
  const qc = useQueryClient();
  const all = useVessels();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [registering, setRegistering] = useState(false);
  const [newLen, setNewLen] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = all.data?.find((v) => v.id === value);
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (all.data ?? []).filter((v) => !t || v.name.toLowerCase().includes(t)).slice(0, 40);
  }, [all.data, q]);

  const create = useMutation({
    mutationFn: () => api.createVessel({ name: q.trim(), lengthFt: Number(newLen) }),
    onSuccess: (v) => {
      qc.invalidateQueries({ queryKey: [pid, "vessels"] });
      onChange(v); setRegistering(false); setOpen(false); setQ(""); setNewLen("");
    },
  });

  const pick = (v: Vessel) => { onChange(v); setOpen(false); setQ(""); };

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls="vessel-list"
        aria-invalid={invalid || undefined}
        placeholder={selected ? "" : "Search vessels…"}
        value={open ? q : selected ? `${selected.name}` : q}
        onFocus={() => { setOpen(true); setQ(""); }}
        onBlur={() => setTimeout(() => { if (!registering) setOpen(false); }, 150)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, matches.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === "Enter" && open && matches[active]) { e.preventDefault(); pick(matches[active]); }
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {!open && selected && (
        <span className="num pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-ink-muted">LOA {ft(selected.lengthFt)}</span>
      )}
      {open && (
        <div id="vessel-list" role="listbox" className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-lg border bg-popover p-1 shadow-lg">
          {all.isLoading && <p className="p-2 text-xs text-ink-muted">Loading vessels…</p>}
          {matches.map((v, i) => (
            <button key={v.id} type="button" role="option" aria-selected={v.id === value}
              onMouseDown={(e) => e.preventDefault()} onClick={() => pick(v)} onMouseEnter={() => setActive(i)}
              className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm", i === active && "bg-accent")}>
              <Ship className="size-3.5 text-ink-muted" />
              <span className="flex-1 truncate">{v.name}</span>
              <span className={cn("num text-xs", v.lengthFt == null ? "text-brass" : "text-ink-muted")}>{v.lengthFt == null ? "length?" : ft(v.lengthFt)}</span>
              {v.id === value && <Check className="size-3.5 text-harbor" />}
            </button>
          ))}
          {!all.isLoading && matches.length === 0 && <p className="p-2 text-xs text-ink-muted">No vessel matches “{q}”.</p>}
          <div className="mt-1 border-t pt-1">
            {!registering ? (
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setRegistering(true)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-harbor hover:bg-accent">
                <Plus className="size-3.5" /> Register new vessel{q.trim() ? ` “${q.trim()}”` : ""}
              </button>
            ) : (
              <div className="space-y-2 p-2" onMouseDown={(e) => e.stopPropagation()}>
                <div className="flex gap-2">
                  <Input autoFocus placeholder="Name, e.g. R/V Tern" value={q} onChange={(e) => setQ(e.target.value)} className="flex-1" />
                  <Input placeholder="LOA ft" inputMode="decimal" value={newLen} onChange={(e) => setNewLen(e.target.value)} className="num w-24" />
                </div>
                {create.error && <p className="text-xs text-signal">{errorMessage(create.error)}</p>}
                <div className="flex justify-end gap-2">
                  <Button type="button" size="sm" variant="ghost" onClick={() => { setRegistering(false); setOpen(false); }}>Cancel</Button>
                  <Button type="button" size="sm" disabled={!q.trim() || !(Number(newLen) > 0) || create.isPending} onClick={() => create.mutate()}>Register</Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
