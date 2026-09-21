"use client";
// The "today" control (frontend.md §3.9): a pill showing the project's as-of date, real or overridden.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Anchor, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { errorMessage } from "@/lib/api/client";
import { DATE_MAX, DATE_MIN } from "@shared/contract";
import { formatDay, isISODate } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useProjectCtx, useSettings } from "./project-context";

export function TodayChip() {
  const { pid, api } = useProjectCtx();
  const qc = useQueryClient();
  const s = useSettings();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const put = useMutation({
    mutationFn: (asOfDate: string | null) => api.putSettings({ asOfDate }),
    onSuccess: (next) => {
      qc.setQueryData([pid, "settings"], next);
      for (const k of ["schedule", "bookings", "availability"]) qc.invalidateQueries({ queryKey: [pid, k] });
      // move the calendar to the new today
      if (pathname === `/p/${pid}` && params.get("date")) {
        const sp = new URLSearchParams(params); sp.delete("date");
        router.replace(`${pathname}?${sp}`);
      }
      setOpen(false);
    },
  });

  if (!s.data) return <div className="h-7 w-40 animate-pulse rounded-full bg-muted" />;
  const override = s.data.asOfSource === "override";

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setDraft(s.data!.asOfDate); }}>
      <PopoverTrigger
        className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors",
          override ? "border-brass/60 bg-brass-soft text-ink" : "bg-surface text-ink hover:bg-accent")}
        aria-label={`Today is ${formatDay(s.data.asOfDate)}${override ? ", overridden" : ""}. Change`}>
        <Anchor className={cn("size-3.5", override ? "text-brass" : "text-harbor")} />
        <span className="text-ink-muted">{override ? "Viewing as of" : "Today"}</span>
        <span className="num font-medium">{formatDay(s.data.asOfDate)}</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="space-y-1">
          <p className="font-medium">Planning from</p>
          <p className="text-xs text-ink-muted">
            &ldquo;Today&rdquo; anchors this project: the default calendar view, the today line, and which bookings count as past.
            It never changes what is valid.
          </p>
        </div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (isISODate(draft)) put.mutate(draft); }}>
          <Input type="date" min={DATE_MIN} max={DATE_MAX} className="num" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="As-of date" />
          <Button type="submit" size="sm" disabled={!isISODate(draft) || put.isPending}>Set</Button>
        </form>
        {override && (
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => put.mutate(null)} disabled={put.isPending}>
            <RotateCcw /> Use the real date
          </Button>
        )}
        {put.error && <p className="text-xs text-signal">{errorMessage(put.error)}</p>}
      </PopoverContent>
    </Popover>
  );
}
