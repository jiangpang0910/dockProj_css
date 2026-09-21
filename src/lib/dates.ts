/**
 * Client-side ISODate helpers (frontend.md §6). An ISODate is "YYYY-MM-DD": a calendar day, no time, no zone.
 * All arithmetic runs in UTC so the viewer's zone can never shift a day. Never `new Date(iso)` elsewhere.
 * (Pure helpers mirrored from src/server/domain/dates.ts — server code is not imported into the client bundle.)
 */
import type { ISODate } from "@shared/contract";

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
export const FACILITY_TZ = "America/New_York";

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== "string") return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function parts(d: ISODate): [number, number, number] {
  const [y, m, day] = d.split("-").map(Number);
  return [y, m, day];
}
function toUTC(d: ISODate): Date {
  const [y, m, day] = parts(d);
  return new Date(Date.UTC(y, m - 1, day));
}
function fromUTC(t: Date): ISODate {
  return t.toISOString().slice(0, 10);
}
export function iso(y: number, m: number, d: number): ISODate {
  return fromUTC(new Date(Date.UTC(y, m - 1, d)));
}

export const addDays = (d: ISODate, n: number): ISODate => fromUTC(new Date(toUTC(d).getTime() + n * DAY_MS));
export function addMonths(d: ISODate, n: number): ISODate {
  const [y, m, day] = parts(d);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  return iso(ny, nm, Math.min(day, daysInMonth(ny, nm)));
}
export const addYears = (d: ISODate, n: number): ISODate => addMonths(d, n * 12);
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const diffDays = (a: ISODate, b: ISODate) => Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / DAY_MS);
/** Days an inclusive range occupies: 5–9 → 5. */
export const spanDays = (s: ISODate, e: ISODate) => diffDays(s, e) + 1;
export const overlaps = (aS: ISODate, aE: ISODate, bS: ISODate, bE: ISODate) => aS <= bE && bS <= aE;
export const minDate = (a: ISODate, b: ISODate) => (a < b ? a : b);
export const maxDate = (a: ISODate, b: ISODate) => (a > b ? a : b);

/** 0 = Monday … 6 = Sunday. */
export const weekday = (d: ISODate) => (toUTC(d).getUTCDay() + 6) % 7;
export const isWeekend = (d: ISODate) => weekday(d) >= 5;
export const startOfWeek = (d: ISODate) => addDays(d, -weekday(d));
export function startOfMonth(d: ISODate): ISODate { const [y, m] = parts(d); return iso(y, m, 1); }
export function endOfMonth(d: ISODate): ISODate { const [y, m] = parts(d); return iso(y, m, daysInMonth(y, m)); }
export function startOfQuarter(d: ISODate): ISODate { const [y, m] = parts(d); return iso(y, Math.floor((m - 1) / 3) * 3 + 1, 1); }
export function startOfYear(d: ISODate): ISODate { return iso(parts(d)[0], 1, 1); }

/** Every day from s to e inclusive. */
export function eachDay(s: ISODate, e: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = s; d <= e; d = addDays(d, 1)) out.push(d);
  return out;
}

export function todayIn(timeZone = FACILITY_TZ, now: Date = new Date()): ISODate {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const WEEKDAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "5 Mar 2027" */
export function formatDay(d: ISODate): string {
  const [y, m, day] = parts(d);
  return `${day} ${MONTHS[m - 1]} ${y}`;
}
/** "Mon 5 Mar" */
export function formatDayShort(d: ISODate): string {
  const [, m, day] = parts(d);
  return `${WEEKDAYS[weekday(d)]} ${day} ${MONTHS[m - 1]}`;
}
/** "4–6 Mar 2026", "28 Feb – 2 Mar 2026", "30 Dec 2026 – 2 Jan 2027", "5 Mar 2026". */
export function formatRange(start: ISODate, end: ISODate): string {
  const [sy, sm, sd] = parts(start);
  const [ey, em, ed] = parts(end);
  if (start === end) return `${sd} ${MONTHS[sm - 1]} ${sy}`;
  if (sy === ey && sm === em) return `${sd}–${ed} ${MONTHS[em - 1]} ${ey}`;
  if (sy === ey) return `${sd} ${MONTHS[sm - 1]} – ${ed} ${MONTHS[em - 1]} ${ey}`;
  return `${sd} ${MONTHS[sm - 1]} ${sy} – ${ed} ${MONTHS[em - 1]} ${ey}`;
}
/** Spoken form for aria labels: "3 to 6 March 2026". */
export function spokenRange(start: ISODate, end: ISODate): string {
  const [sy, sm, sd] = parts(start);
  const [ey, em, ed] = parts(end);
  if (start === end) return `${sd} ${MONTHS_LONG[sm - 1]} ${sy}`;
  if (sy === ey && sm === em) return `${sd} to ${ed} ${MONTHS_LONG[em - 1]} ${ey}`;
  return `${sd} ${MONTHS_LONG[sm - 1]} ${sy} to ${ed} ${MONTHS_LONG[em - 1]} ${ey}`;
}
export function monthLabel(d: ISODate): string {
  const [y, m] = parts(d);
  return `${MONTHS_LONG[m - 1]} ${y}`;
}
/** ISO timestamp → "21 Sep 2026, 14:05" in the viewer's zone (audit fields only). */
export function formatInstant(ts: string): string {
  const t = new Date(ts);
  if (Number.isNaN(t.getTime())) return ts;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(t);
}
