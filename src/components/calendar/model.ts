// Calendar state and pure helpers (frontend.md §3.1): lens × scale, windows, lanes, occupancy.
import type { Berth, BookingView, ISODate, OccupantType } from "@shared/contract";
import {
  MONTHS, MONTHS_LONG, addDays, addMonths, addYears, eachDay, endOfMonth, formatDay, maxDate, minDate, parts,
  startOfMonth, startOfQuarter, startOfWeek, startOfYear,
} from "@/lib/dates";

export type Lens = "berths" | "berth" | "vessels" | "vessel";
export type Scale = "day" | "week" | "month" | "quarter" | "year";
export const LENSES: { id: Lens; label: string }[] = [
  { id: "berths", label: "All berths" }, { id: "berth", label: "One berth" },
  { id: "vessels", label: "All vessels" }, { id: "vessel", label: "One vessel" },
];
export const SCALES: { id: Scale; label: string; key: string }[] = [
  { id: "day", label: "Day", key: "d" }, { id: "week", label: "Week", key: "w" }, { id: "month", label: "Month", key: "m" },
  { id: "quarter", label: "Quarter", key: "q" }, { id: "year", label: "Year", key: "y" },
];

export interface CalState {
  lens: Lens; id: string | null; scale: Scale; date: ISODate | null;
  types: OccupantType[]; berths: string[] | null; nonVessel: boolean;
}
const ALL_TYPES: OccupantType[] = ["vessel", "event", "closure"];

export function readState(p: URLSearchParams): CalState {
  const lens = (LENSES.some((l) => l.id === p.get("lens")) ? p.get("lens") : "berths") as Lens;
  const scale = (SCALES.some((s) => s.id === p.get("scale")) ? p.get("scale") : "month") as Scale;
  const types = p.get("types") ? (p.get("types")!.split(",").filter((t) => ALL_TYPES.includes(t as OccupantType)) as OccupantType[]) : ALL_TYPES;
  return {
    lens, scale, id: p.get("id"), date: /^\d{4}-\d{2}-\d{2}$/.test(p.get("date") ?? "") ? p.get("date") : null,
    types: types.length ? types : ALL_TYPES,
    berths: p.get("berths") ? p.get("berths")!.split(",").filter(Boolean) : null,
    nonVessel: p.get("nonvessel") === "1",
  };
}

export function writeState(s: CalState): string {
  const p = new URLSearchParams();
  p.set("lens", s.lens);
  if (s.id && (s.lens === "berth" || s.lens === "vessel")) p.set("id", s.id);
  p.set("scale", s.scale);
  if (s.date) p.set("date", s.date);
  if (s.types.length !== ALL_TYPES.length) p.set("types", s.types.join(","));
  if (s.berths) p.set("berths", s.berths.join(","));
  if (s.nonVessel) p.set("nonvessel", "1");
  return p.toString();
}

/** The days a scale shows around an anchor date. */
export function viewRange(scale: Scale, d: ISODate): { from: ISODate; to: ISODate } {
  switch (scale) {
    case "day": return { from: d, to: d };
    case "week": { const s = startOfWeek(d); return { from: s, to: addDays(s, 6) }; }
    case "month": return { from: startOfMonth(d), to: endOfMonth(d) };
    case "quarter": { const s = startOfQuarter(d); return { from: s, to: addDays(addMonths(s, 3), -1) }; }
    case "year": { const s = startOfYear(d); return { from: s, to: addDays(addYears(s, 1), -1) }; }
  }
}
/** What to fetch: the view range, widened for the day scale so "previous / next / free until" have context (≤ 366 days). */
export function fetchRange(scale: Scale, d: ISODate): { from: ISODate; to: ISODate } {
  if (scale === "day") return { from: addDays(d, -183), to: addDays(d, 182) };
  return viewRange(scale, d);
}
export function step(scale: Scale, d: ISODate, dir: 1 | -1): ISODate {
  switch (scale) {
    case "day": return addDays(d, dir);
    case "week": return addDays(d, 7 * dir);
    case "month": return addMonths(d, dir);
    case "quarter": return addMonths(d, 3 * dir);
    case "year": return addYears(d, dir);
  }
}
export function title(scale: Scale, d: ISODate): string {
  const [y, m] = parts(d);
  switch (scale) {
    case "day": return formatDay(d);
    case "week": return `Week of ${formatDay(viewRange("week", d).from)}`;
    case "month": return `${MONTHS_LONG[m - 1]} ${y}`;
    case "quarter": { const q = Math.floor((m - 1) / 3); return `Q${q + 1} ${y} · ${MONTHS[q * 3]}–${MONTHS[q * 3 + 2]}`; }
    case "year": return `${y}`;
  }
}

/** Clip a booking to a window; null if it doesn't touch it. */
export function clip(b: { startDate: ISODate; endDate: ISODate }, from: ISODate, to: ISODate) {
  if (b.endDate < from || b.startDate > to) return null;
  return { s: maxDate(b.startDate, from), e: minDate(b.endDate, to), cutStart: b.startDate < from, cutEnd: b.endDate > to };
}

/** Greedy lanes by start date: each booking goes into the first lane whose last booking ended before it starts. */
export function assignLanes<T extends { startDate: ISODate; endDate: ISODate }>(items: T[]): { item: T; lane: number }[] {
  const sorted = [...items].sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : a.endDate < b.endDate ? -1 : 1));
  const laneEnds: ISODate[] = [];
  return sorted.map((item) => {
    let lane = laneEnds.findIndex((end) => end < item.startDate);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(item.endDate); } else laneEnds[lane] = item.endDate;
    return { item, lane };
  });
}

/** Share of active berths occupied on each day of [from, to]. */
export function occupancy(berths: Berth[], bookings: BookingView[], from: ISODate, to: ISODate): { day: ISODate; share: number; taken: number; total: number }[] {
  const exclusive = new Set(berths.filter((b) => b.active).map((b) => b.id));
  const total = exclusive.size;
  const days = eachDay(from, to);
  const taken = new Map<ISODate, Set<string>>(days.map((d) => [d, new Set()]));
  for (const b of bookings) {
    if (!exclusive.has(b.berthId)) continue;
    const c = clip(b, from, to);
    if (!c) continue;
    for (let d = c.s; d <= c.e; d = addDays(d, 1)) taken.get(d)?.add(b.berthId);
  }
  return days.map((d) => ({ day: d, taken: taken.get(d)!.size, total, share: total ? taken.get(d)!.size / total : 0 }));
}

/** Stable, calm colours per berth for the vessel lenses. Never the conflict red, never the event brass. */
const BERTH_HUES = ["#1f5f8b", "#2f7d6d", "#6b5b95", "#3d7a8a", "#4f6d3a", "#7d5a73", "#2e5c6e", "#5b6b78", "#46607f", "#6a7a48"];
export function berthColors(berths: Berth[]): Map<string, string> {
  return new Map([...berths].sort((a, b) => a.sortOrder - b.sortOrder).map((b, i) => [b.id, BERTH_HUES[i % BERTH_HUES.length]]));
}
