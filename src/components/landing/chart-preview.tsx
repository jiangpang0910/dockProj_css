// The landing visual: a quiet slice of the schedule, drawn statically. Not a screenshot, not stock art.
const ROWS: { name: string; len: string; bars: { s: number; e: number; t: "vessel" | "event" | "closure"; label?: string }[] }[] = [
  { name: "North Pier West", len: "410′", bars: [{ s: 1, e: 6, t: "vessel", label: "R/V High Drift · 120′" }, { s: 9, e: 9, t: "event" }, { s: 11, e: 17, t: "vessel", label: "R/V Northern Meridian" }] },
  { name: "North Pier Face", len: "75′", bars: [{ s: 3, e: 4, t: "vessel", label: "F/V Swift Dory" }, { s: 7, e: 10, t: "closure", label: "Bollard repair" }] },
  { name: "North Pier East", len: "240′", bars: [{ s: 0, e: 2, t: "vessel" }, { s: 5, e: 13, t: "vessel", label: "M/V Golden Compass · 124′" }] },
  { name: "Inner Channel", len: "55′", bars: [{ s: 2, e: 2, t: "event" }, { s: 12, e: 15, t: "vessel", label: "S/V Kittiwake" }] },
  { name: "South Float West", len: "90′", bars: [{ s: 4, e: 8, t: "vessel", label: "Tug Western Current" }, { s: 14, e: 17, t: "vessel" }] },
  { name: "South Float East", len: "90′", bars: [{ s: 0, e: 1, t: "vessel" }, { s: 6, e: 6, t: "event", label: "Sail day" }, { s: 9, e: 12, t: "vessel", label: "S/V Iron Petrel" }] },
];
const DAYS = 18;
const style = {
  vessel: "bg-harbor-soft border-harbor/50",
  event: "bg-brass-soft border-brass/50",
  closure: "hatch border-ink-muted/50",
};

export function ChartPreview() {
  return (
    <div aria-hidden className="relative overflow-hidden rounded-xl border bg-surface shadow-[0_1px_0_var(--rule),0_24px_48px_-24px_color-mix(in_oklab,var(--ink)_30%,transparent)]">
      <div className="flex items-center justify-between border-b px-4 py-2.5 text-xs text-ink-muted">
        <span className="font-medium text-ink">July 2019</span>
        <span className="num">6 berths · 2 shared sections</span>
      </div>
      <div className="grid" style={{ gridTemplateColumns: `8.5rem repeat(${DAYS}, minmax(0, 1fr))` }}>
        <div className="border-b" />
        {Array.from({ length: DAYS }, (_, i) => (
          <div key={i} className={`num border-b border-l py-1 text-center text-[10px] text-ink-muted ${i % 7 >= 5 ? "bg-muted/60" : ""}`}>{i + 1}</div>
        ))}
        {ROWS.map((r) => (
          <div key={r.name} className="contents">
            <div className="flex items-baseline justify-between gap-1 border-b px-3 py-2 text-[11px]">
              <span className="truncate font-medium">{r.name}</span><span className="num text-ink-muted">{r.len}</span>
            </div>
            <div className="relative col-span-full col-start-2 border-b" style={{ gridColumn: `2 / span ${DAYS}` }}>
              <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${DAYS}, 1fr)` }}>
                {Array.from({ length: DAYS }, (_, i) => <div key={i} className={`border-l ${i % 7 >= 5 ? "bg-muted/60" : ""}`} />)}
              </div>
              {r.bars.map((b, i) => (
                <div key={i} className={`absolute top-1.5 bottom-1.5 truncate rounded-[3px] border px-1.5 text-[10px] leading-[18px] ${style[b.t]}`}
                  style={{ left: `calc(${(b.s / DAYS) * 100}% + 2px)`, width: `calc(${((b.e - b.s + 1) / DAYS) * 100}% - 4px)` }}>
                  {b.label}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {/* today line */}
      <div className="pointer-events-none absolute top-9 bottom-0 w-px bg-signal/0" />
      <div className="pointer-events-none absolute top-[34px] bottom-0 border-l-2 border-harbor" style={{ left: `calc(8.5rem + (100% - 8.5rem) * ${9.5 / DAYS})` }}>
        <span className="absolute -top-0.5 -translate-x-1/2 rounded bg-harbor px-1 text-[9px] font-medium text-white">today</span>
      </div>
    </div>
  );
}
