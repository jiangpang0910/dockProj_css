"use client";
// One shared hover card for every bar on screen (hundreds of bars, one floating card):
// vessel, LOA vs berth length, dates, notes (frontend.md §2 "hover detail").
import { createContext, useContext, useState } from "react";
import { createPortal } from "react-dom";
import type { BookingView } from "@shared/contract";
import { formatRange, spanDays } from "@/lib/dates";
import { ft, occupantLabel, plural } from "@/lib/format";
import { OccupantIcon } from "@/components/booking/occupant";

type Hover = { b: BookingView; x: number; y: number } | null;
const Ctx = createContext<(h: Hover) => void>(() => {});
export const useHover = () => useContext(Ctx);

export function HoverProvider({ children }: { children: React.ReactNode }) {
  const [h, setH] = useState<Hover>(null);
  return (
    <Ctx.Provider value={setH}>
      {children}
      {h && typeof document !== "undefined" && createPortal(<Card h={h} />, document.body)}
    </Ctx.Provider>
  );
}

function Card({ h }: { h: NonNullable<Hover> }) {
  const { b } = h;
  const left = Math.min(h.x + 14, (typeof window !== "undefined" ? window.innerWidth : 1200) - 300);
  const tooShort = b.vesselLengthFt != null && b.berthLengthFt != null && b.vesselLengthFt > b.berthLengthFt;
  return (
    <div role="tooltip" className="pointer-events-none fixed z-[60] w-72 rounded-lg border bg-popover p-3 text-sm shadow-xl"
      style={{ left, top: h.y + 16 }}>
      <div className="flex items-center gap-1.5 text-[11px] tracking-wide text-ink-muted uppercase">
        <OccupantIcon type={b.occupantType} /> {occupantLabel[b.occupantType]} · {b.source === "import" ? "imported" : "manual"}
      </div>
      <p className="mt-1 font-semibold">{b.title}</p>
      <p className="num text-xs text-ink-muted">{formatRange(b.startDate, b.endDate)} · {plural(spanDays(b.startDate, b.endDate), "day")}</p>
      <p className="mt-2 text-xs">
        {b.berthName} <span className="num text-ink-muted">{b.berthLengthFt == null ? "shared" : ft(b.berthLengthFt)}</span>
        {b.occupantType === "vessel" && (
          <> · LOA <span className={`num ${tooShort ? "text-signal" : ""}`}>{ft(b.vesselLengthFt)}</span>
            {b.vesselLengthFt != null && b.berthLengthFt != null && !tooShort && <span className="num text-ok"> ({ft(b.berthLengthFt - b.vesselLengthFt)} spare)</span>}</>
        )}
      </p>
      {b.notes && <p className="mt-2 line-clamp-3 border-t pt-2 text-xs text-ink-muted">{b.notes}</p>}
    </div>
  );
}
