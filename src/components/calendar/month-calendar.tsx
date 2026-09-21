"use client";
// The Month calendar (7 × 6 cells) for one berth or one vessel, plus a mini version for quarter/year overviews.
import { useMemo } from "react";
import type { BookingView, ISODate } from "@shared/contract";
import { MONTHS_LONG, WEEKDAYS, addDays, diffDays, endOfMonth, parts, spokenRange, startOfMonth, startOfWeek, formatDayShort } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { OccupantIcon, occupantStyle } from "@/components/booking/occupant";
import { assignLanes, clip } from "./model";
import { useHover } from "./hover";

function weeksOf(month: ISODate): ISODate[] {
  const first = startOfWeek(startOfMonth(month));
  return Array.from({ length: 6 }, (_, i) => addDays(first, i * 7));
}

export function MonthCalendar({
  month, bookings, today, onOpen, onDay, colorOf, labelOf, compact = false,
}: {
  month: ISODate;
  bookings: BookingView[];
  today?: ISODate;
  onOpen: (id: string) => void;
  onDay?: (d: ISODate) => void;
  colorOf?: (b: BookingView) => string | undefined;
  labelOf: (b: BookingView) => string;
  compact?: boolean;
}) {
  const setHover = useHover();
  const [, m] = parts(month);
  const mStart = startOfMonth(month), mEnd = endOfMonth(month);
  const weeks = useMemo(() => weeksOf(month), [month]);
  const LANE = compact ? 16 : 20;

  return (
    <div className="overflow-hidden rounded-xl border bg-surface">
      <div className="flex items-baseline justify-between border-b px-3 py-2">
        <h3 className={cn("font-semibold", compact ? "text-sm" : "text-base")}>{MONTHS_LONG[m - 1]} <span className="num font-normal text-ink-muted">{parts(month)[0]}</span></h3>
      </div>
      <div className="grid grid-cols-7 border-b text-center text-[10px] tracking-wide text-ink-muted uppercase">
        {WEEKDAYS.map((w, i) => <div key={w} className={cn("py-1", i >= 5 && "bg-muted/60")}>{compact ? w[0] : w}</div>)}
      </div>
      {weeks.map((wk) => {
        const wkEnd = addDays(wk, 6);
        const placed = assignLanes(bookings.filter((b) => clip(b, wk, wkEnd)));
        const lanes = Math.max(1, ...placed.map((p) => p.lane + 1));
        return (
          <div key={wk} className="relative grid grid-cols-7 border-b last:border-b-0">
            {Array.from({ length: 7 }, (_, i) => {
              const d = addDays(wk, i);
              const inMonth = d >= mStart && d <= mEnd;
              return (
                <button key={d} type="button" onClick={() => onDay?.(d)} disabled={!onDay}
                  aria-label={`${formatDayShort(d)}${onDay ? ", new booking" : ""}`}
                  className={cn("border-l text-left first:border-l-0", i >= 5 && "bg-muted/50", !inMonth && "bg-muted/30 text-ink-muted/50", onDay && "hover:bg-accent")}
                  style={{ height: (compact ? 18 : 24) + lanes * LANE + 6 }}>
                  <span className={cn("num block px-1.5 pt-1 text-[11px]", d === today && "font-bold text-harbor")}>
                    {d === today ? <span className="rounded-full bg-harbor px-1.5 py-px text-white">{parts(d)[2]}</span> : parts(d)[2]}
                  </span>
                </button>
              );
            })}
            {placed.map(({ item: b, lane }) => {
              const c = clip(b, wk, wkEnd)!;
              const i0 = diffDays(wk, c.s), len = diffDays(c.s, c.e) + 1;
              const color = colorOf?.(b);
              return (
                <button key={b.id} type="button" onClick={() => onOpen(b.id)}
                  aria-label={`${b.title}, ${b.berthName}, ${spokenRange(b.startDate, b.endDate)}`}
                  onMouseEnter={(e) => setHover({ b, x: e.clientX, y: e.clientY })} onMouseLeave={() => setHover(null)}
                  className={cn("absolute flex items-center gap-1 overflow-hidden rounded-[4px] border px-1.5 text-left text-[11px] leading-none hover:brightness-95",
                    occupantStyle[b.occupantType], c.cutStart && "rounded-l-none", c.cutEnd && "rounded-r-none")}
                  style={{
                    left: `calc(${(i0 / 7) * 100}% + 2px)`, width: `calc(${(len / 7) * 100}% - 4px)`,
                    top: (compact ? 18 : 24) + lane * LANE, height: LANE - 3,
                    ...(color && b.occupantType === "vessel" ? { background: `color-mix(in oklab, ${color} 20%, var(--surface))`, borderColor: `color-mix(in oklab, ${color} 55%, transparent)` } : {}),
                  }}>
                  {!compact && <OccupantIcon type={b.occupantType} className="size-3 opacity-70" />}
                  <span className="truncate font-medium">{labelOf(b)}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** A mini month: one small square per day, filled when occupied. For year overviews. */
export function MiniMonth({ month, bookings, today, colorOf, onPick }: {
  month: ISODate; bookings: BookingView[]; today?: ISODate; colorOf: (b: BookingView) => string; onPick: () => void;
}) {
  const [, m] = parts(month);
  const mStart = startOfMonth(month), mEnd = endOfMonth(month);
  const weeks = weeksOf(month);
  const byDay = new Map<ISODate, BookingView>();
  for (const b of bookings) {
    const c = clip(b, mStart, mEnd);
    if (!c) continue;
    for (let d = c.s; d <= c.e; d = addDays(d, 1)) if (!byDay.has(d)) byDay.set(d, b);
  }
  const occupied = byDay.size;
  return (
    <button type="button" onClick={onPick} className="rounded-lg border bg-surface p-2.5 text-left transition-colors hover:border-harbor/50"
      aria-label={`${MONTHS_LONG[m - 1]}: occupied ${occupied} days. Open month`}>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-xs font-semibold">{MONTHS_LONG[m - 1]}</span>
        <span className="num text-[10px] text-ink-muted">{occupied}d</span>
      </div>
      <div className="grid grid-cols-7 gap-[2px]">
        {weeks.flatMap((wk) => Array.from({ length: 7 }, (_, i) => {
          const d = addDays(wk, i);
          if (d < mStart || d > mEnd) return <span key={d} className="aspect-square" />;
          const b = byDay.get(d);
          return (
            <span key={d} className={cn("aspect-square rounded-[2px]", !b && "bg-muted", b?.occupantType === "closure" && "hatch", d === today && "ring-1 ring-harbor")}
              style={b && b.occupantType !== "closure" ? { background: b.occupantType === "event" ? "var(--brass)" : colorOf(b) } : undefined} />
          );
        }))}
      </div>
    </button>
  );
}
