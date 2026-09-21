"use client";
// The Timeline: rows × days. One component serves every "timeline" cell of the lens × scale matrix
// (berths or vessels × week / month / quarter). Rows and bar labels are passed in.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { BookingView, ISODate } from "@shared/contract";
import { WEEKDAY_LETTERS, MONTHS, diffDays, eachDay, formatDayShort, isWeekend, parts, spokenRange, weekday } from "@/lib/dates";
import { ft } from "@/lib/format";
import { cn } from "@/lib/utils";
import { OccupantIcon, occupantStyle } from "@/components/booking/occupant";
import { assignLanes, clip } from "./model";
import { useHover } from "./hover";

export interface TimelineRow {
  key: string;
  label: React.ReactNode;
  aria: string;
  bookings: BookingView[];
  berthId?: string;          // enables drag-to-create and Enter-to-create on empty days
  group?: string;            // a group header is drawn when this changes between rows
}
export interface BarText { text: string; color?: string }

const LANE_H = 26;
const PAD = 6;
const MAX_GROW = 44;   // rows stretch to fill the screen, but never by more than this: a 3-row view stays a 3-row view
const BOTTOM_GAP = 20;

export function Timeline({
  rows, from, to, today, occupancy, barText, onOpen, onCreate, minColWidth, rowNoun,
}: {
  rows: TimelineRow[];
  from: ISODate; to: ISODate; today?: ISODate;
  occupancy?: { day: ISODate; share: number; taken: number; total: number }[];
  barText: (b: BookingView) => BarText;
  onOpen: (id: string) => void;
  onCreate?: (berthId: string, start: ISODate, end: ISODate) => void;
  minColWidth: number;
  rowNoun: string;
}) {
  const days = useMemo(() => eachDay(from, to), [from, to]);
  const n = days.length;
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const LABEL_W = width < 560 ? 124 : 184;   // phones: leave the days most of the screen
  const colW = Math.max(minColWidth, (width - LABEL_W) / n);

  // ── fill the screen: measure where the grid starts and hand the leftover height to the rows ──
  const head = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  useEffect(() => {
    const measure = () => {
      const el = wrap.current; if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      setRoom(window.innerHeight - top - BOTTOM_GAP - (head.current?.offsetHeight ?? 0));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const trackW = colW * n;
  const setHover = useHover();

  const laid = useMemo(() => rows.map((r) => {
    const placed = assignLanes(r.bookings.filter((b) => clip(b, from, to)));
    const lanes = Math.max(1, ...placed.map((p) => p.lane + 1));
    return { row: r, placed, lanes };
  }), [rows, from, to]);
  const groups = laid.filter(({ row }, i) => row.group && row.group !== laid[i - 1]?.row.group).length;
  const natural = laid.reduce((h, { lanes }) => h + lanes * LANE_H + PAD * 2 + 1, 0) + groups * 25;
  const grow = laid.length ? Math.max(0, Math.min(MAX_GROW, (room - natural) / laid.length)) : 0;
  // bars thicken a little as rows grow, so they don't float in empty rows (never more than half the spare room)
  const liftFor = (lanes: number) => Math.min(12, grow / (2 * lanes));

  // ── drag to create ──
  const [drag, setDrag] = useState<{ row: number; a: number; b: number } | null>(null);
  const idxAt = (e: React.PointerEvent, el: HTMLElement) =>
    Math.max(0, Math.min(n - 1, Math.floor((e.clientX - el.getBoundingClientRect().left) / colW)));

  // ── keyboard: roving cell focus ──
  const [cell, setCell] = useState<{ r: number; c: number }>({ r: 0, c: today && today >= from && today <= to ? diffDays(from, today) : 0 });
  const [focused, setFocused] = useState(false);
  const cellBooking = (r: number, c: number) => laid[r]?.row.bookings.find((b) => b.startDate <= days[c] && b.endDate >= days[c]);
  const onKey = (e: React.KeyboardEvent) => {
    const moves: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    if (moves[e.key]) {
      e.preventDefault(); e.stopPropagation();
      const [dr, dc] = moves[e.key];
      setCell((c) => ({ r: Math.max(0, Math.min(laid.length - 1, c.r + dr)), c: Math.max(0, Math.min(n - 1, c.c + dc)) }));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const b = cellBooking(cell.r, cell.c);
      if (b) onOpen(b.id);
      else if (onCreate && laid[cell.r]?.row.berthId) onCreate(laid[cell.r].row.berthId!, days[cell.c], days[cell.c]);
    }
  };
  const focusedDesc = laid[cell.r] ? (() => {
    const b = cellBooking(cell.r, cell.c);
    return `${laid[cell.r].row.aria}, ${formatDayShort(days[cell.c])}: ${b ? `${b.title}, ${spokenRange(b.startDate, b.endDate)}` : "free"}`;
  })() : "";

  const showDayNum = colW >= 18;
  const todayIdx = today && today >= from && today <= to ? diffDays(from, today) : -1;
  const monthStarts = days.map((d, i) => ({ d, i })).filter(({ d, i }) => i === 0 || parts(d)[2] === 1);

  return (
    <div ref={wrap} className="timeline-panel relative w-full overflow-x-auto rounded-2xl border bg-surface">
      <div
        role="grid" tabIndex={0} aria-label={`Schedule, ${rowNoun} by day. Arrow keys move, Enter opens.`}
        onKeyDown={onKey} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        className="relative outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        style={{ width: LABEL_W + trackW }}
      >
        <p className="sr-only" aria-live="polite">{focused ? focusedDesc : ""}</p>

        {/* ── header ── */}
        <div ref={head} className="sticky top-0 z-20 bg-surface" role="row">
          <div className="flex border-b border-rule">
            <div className="sticky left-0 z-10 flex shrink-0 items-end px-4 pb-2 text-[10px] font-medium tracking-wide text-ink-muted uppercase" style={{ width: LABEL_W }}>
              {rowNoun}
            </div>
            <div className="relative" style={{ width: trackW }}>
              <div className="relative h-6">
                {monthStarts.map(({ d, i }) => (
                  <span key={d} className="absolute top-2 pl-1.5 text-[11px] font-semibold" style={{ left: i * colW }}>{MONTHS[parts(d)[1] - 1]} {i === 0 || parts(d)[1] === 1 ? parts(d)[0] : ""}</span>
                ))}
              </div>
              <div className="flex">
                {days.map((d, i) => (
                  <div key={d} role="columnheader" aria-label={formatDayShort(d)}
                    className={cn("num flex shrink-0 flex-col items-center justify-end gap-0.5 pb-1.5 text-[10px] leading-tight text-ink-muted",
                      isWeekend(d) && "opacity-60")}
                    style={{ width: colW }}>
                    {showDayNum ? <><span className="opacity-70">{colW >= 26 ? WEEKDAY_LETTERS[weekday(d)] : ""}</span><span className={cn("grid size-5 place-items-center rounded-full text-ink", i === todayIdx && "bg-lamp font-bold text-primary-foreground")}>{parts(d)[2]}</span></>
                      : weekday(d) === 0 ? <span className="text-ink">{parts(d)[2]}</span> : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
          {occupancy && (
            <div className="flex border-b border-rule" aria-label="Occupancy of exclusive berths per day">
              <div className="sticky left-0 z-10 shrink-0 px-4 py-0.5 text-[10px] text-ink-muted" style={{ width: LABEL_W }}>
                Berths taken
              </div>
              <div className="flex h-5 items-end" style={{ width: trackW }}>
                {occupancy.map((o) => (
                  <div key={o.day} title={`${formatDayShort(o.day)}: ${o.taken} of ${o.total} berths taken`} className="flex h-full shrink-0 items-end px-px" style={{ width: colW }}>
                    <div className={cn("w-full rounded-t-[1px]", o.share >= 1 ? "bg-harbor" : "bg-harbor/45")} style={{ height: `${Math.max(o.share * 100, o.taken ? 8 : 0)}%` }} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── body ── */}
        <div className="relative">
          {/* column layer: weekend shading + gridlines + today line, drawn once for all rows */}
          <div aria-hidden className="pointer-events-none absolute inset-y-0" style={{
            left: LABEL_W, width: trackW,
            backgroundImage: colW >= 10 ? "linear-gradient(90deg, var(--rule) 1px, transparent 1px)" : undefined,
            backgroundSize: `${colW}px 100%`,
          }}>
            {days.map((d, i) => isWeekend(d) ? <div key={d} className="absolute inset-y-0 bg-ink/[0.035]" style={{ left: i * colW, width: colW }} /> : null)}
            {todayIdx >= 0 && <div className="absolute inset-y-0 z-[3] w-0.5 bg-lamp" style={{ left: todayIdx * colW + colW / 2 - 1 }} />}
          </div>

          {laid.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-ink-muted" style={{ width: LABEL_W + trackW }}>Nothing to show here with the current filters.</div>
          )}

          {laid.map(({ row, placed, lanes }, r) => (
            <Fragment key={row.key}>
              {row.group && row.group !== laid[r - 1]?.row.group && (
                <div className="flex border-b border-rule bg-muted/40">
                  <div className="sticky left-0 px-4 py-1 text-[11px] font-semibold tracking-wide text-ink-muted uppercase" style={{ width: LABEL_W }}>{row.group}</div>
                </div>
              )}
              <div role="row" aria-label={row.aria} className="flex border-b border-rule last:border-b-0">
                <div role="rowheader" className="timeline-label @container sticky left-0 z-10 flex shrink-0 items-center px-3 text-sm sm:px-4" style={{ width: LABEL_W, minHeight: lanes * LANE_H + PAD * 2 + grow }}>
                  {row.label}
                </div>
                <div
                  className={cn("relative shrink-0", row.berthId && onCreate && "cursor-crosshair")}
                  style={{ width: trackW, height: lanes * LANE_H + PAD * 2 + grow }}
                  onPointerDown={(e) => {
                    if (!row.berthId || !onCreate || e.button !== 0 || (e.target as HTMLElement).closest("[data-bar]")) return;
                    const i = idxAt(e, e.currentTarget);
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setDrag({ row: r, a: i, b: i });
                  }}
                  onPointerMove={(e) => { if (drag?.row === r) setDrag({ ...drag, b: idxAt(e, e.currentTarget) }); }}
                  onPointerUp={() => {
                    if (drag?.row === r && row.berthId && onCreate) {
                      const [a, b] = [Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)];
                      onCreate(row.berthId, days[a], days[b]);
                    }
                    setDrag(null);
                  }}
                >
                  {drag?.row === r && (
                    <div className="absolute inset-y-1 z-[6] rounded border-2 border-dashed border-harbor bg-harbor/10"
                      style={{ left: Math.min(drag.a, drag.b) * colW, width: (Math.abs(drag.b - drag.a) + 1) * colW }}>
                      <span className="num absolute -top-0.5 left-1 text-[10px] font-medium text-harbor">{Math.abs(drag.b - drag.a) + 1}d</span>
                    </div>
                  )}
                  {focused && cell.r === r && (
                    <div aria-hidden className="pointer-events-none absolute inset-y-0.5 z-[7] rounded-sm ring-2 ring-harbor" style={{ left: cell.c * colW, width: colW }} />
                  )}
                  {placed.map(({ item: b, lane }) => {
                    const c = clip(b, from, to)!;
                    const i0 = diffDays(from, c.s), len = diffDays(c.s, c.e) + 1;
                    const w = len * colW - 2;
                    const t = barText(b);
                    return (
                      <button
                        key={b.id} data-bar type="button" tabIndex={-1}
                        aria-label={`${b.title}${b.vesselLengthFt != null ? `, ${b.vesselLengthFt} feet` : ""}, ${b.berthName}, ${spokenRange(b.startDate, b.endDate)}`}
                        onClick={() => onOpen(b.id)}
                        onMouseEnter={(e) => setHover({ b, x: e.clientX, y: e.clientY })}
                        onMouseMove={(e) => setHover({ b, x: e.clientX, y: e.clientY })}
                        onMouseLeave={() => setHover(null)}
                        className={cn("absolute z-[4] flex items-center gap-1 overflow-hidden rounded-md border text-left text-[11px] leading-none transition-[filter] hover:brightness-95 hover:saturate-150",
                          occupantStyle[b.occupantType], c.cutStart && "rounded-l-none border-l-0", c.cutEnd && "rounded-r-none border-r-0")}
                        style={{
                          left: i0 * colW + 1, width: w, top: PAD + (grow - lanes * liftFor(lanes)) / 2 + lane * (LANE_H + liftFor(lanes)), height: LANE_H + liftFor(lanes) - 4,
                          ...(t.color && b.occupantType === "vessel" ? { background: `color-mix(in oklab, ${t.color} 18%, var(--surface))`, borderColor: `color-mix(in oklab, ${t.color} 55%, transparent)` } : {}),
                          boxShadow: `inset 3px 0 0 ${c.cutStart ? "transparent" : t.color && b.occupantType === "vessel" ? t.color : "var(--bar-edge)"}`,
                        }}
                      >
                        {c.cutStart && <ChevronLeft aria-hidden className="size-3 shrink-0 text-ink-muted" />}
                        {w <= 34 && w > 16 && !c.cutStart && <OccupantIcon type={b.occupantType} className="mx-auto size-3 opacity-70" />}
                        {w > 34 && <span className={cn("flex min-w-0 items-center gap-1", !c.cutStart && "pl-1.5")}>
                          <OccupantIcon type={b.occupantType} className="size-3 opacity-70" />
                          <span className="truncate font-medium">{t.text}</span>
                        </span>}
                        {c.cutEnd && <ChevronRight aria-hidden className="ml-auto size-3 shrink-0 text-ink-muted" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Row label for a berth: name + length (length is always visible — §2 principle 3). */
export function BerthLabel({ name, lengthFt, shared, inactive }: { name: string; lengthFt: number | null; shared: boolean; inactive?: boolean }) {
  return (
    <span className="flex w-full min-w-0 items-baseline justify-between gap-x-2 py-1 @max-[140px]:flex-col @max-[140px]:gap-0">
      <span className={cn("max-w-full truncate font-medium", inactive && "text-ink-muted line-through")}>{name}</span>
      <span className="num shrink-0 text-xs text-ink-muted">{shared ? "shared" : ft(lengthFt)}</span>
    </span>
  );
}
