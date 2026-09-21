/**
 * ISODate helpers. An ISODate is "YYYY-MM-DD": a calendar day with no time and no zone.
 * All arithmetic goes through UTC so the host's time zone can never shift a day.
 * Never `new Date(iso)` outside this file.
 */
import type { ISODate } from "@shared/contract";

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** True only for real calendar days in canonical form: "2026-02-30" and "2026-3-5" are false. */
export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== "string") return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function toUTC(d: ISODate): Date {
  const m = ISO_RE.exec(d);
  if (!m) throw new Error(`not an ISODate: ${d}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function fromUTC(t: Date): ISODate {
  return t.toISOString().slice(0, 10);
}

export function addDays(d: ISODate, n: number): ISODate {
  return fromUTC(new Date(toUTC(d).getTime() + n * DAY_MS));
}

/** Calendar years; Feb 29 + 1 year → Feb 28 (same as date-fns addYears). */
export function addYears(d: ISODate, n: number): ISODate {
  const t = toUTC(d);
  const y = t.getUTCFullYear() + n, mo = t.getUTCMonth(), day = t.getUTCDate();
  const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return fromUTC(new Date(Date.UTC(y, mo, Math.min(day, lastDay))));
}

/** Whole days from a to b (b − a). */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / DAY_MS);
}

/** Number of days an inclusive range occupies: 5–9 → 5. */
export function spanDays(start: ISODate, end: ISODate): number {
  return diffDays(start, end) + 1;
}

/** Inclusive ranges overlap ⇔ each starts on or before the other ends. ISODates compare correctly as strings. */
export function overlaps(aStart: ISODate, aEnd: ISODate, bStart: ISODate, bEnd: ISODate): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/** Today's calendar date in a given IANA zone (the facility's), independent of the server's zone. */
export function todayIn(timeZone: string, now: Date = new Date()): ISODate {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Human range for messages: "4–6 Mar 2026", "28 Feb – 2 Mar 2026", "30 Dec 2026 – 2 Jan 2027", "5 Mar 2026". */
export function formatRange(start: ISODate, end: ISODate): string {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  if (start === end) return `${sd} ${MONTHS[sm - 1]} ${sy}`;
  if (sy === ey && sm === em) return `${sd}–${ed} ${MONTHS[em - 1]} ${ey}`;
  if (sy === ey) return `${sd} ${MONTHS[sm - 1]} – ${ed} ${MONTHS[em - 1]} ${ey}`;
  return `${sd} ${MONTHS[sm - 1]} ${sy} – ${ed} ${MONTHS[em - 1]} ${ey}`;
}
