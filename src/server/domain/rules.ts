/**
 * The booking rules (manual.md R1–R6 + horizon + warnings). The ONLY place they live in code.
 *
 * Pure: no SQL, no HTTP, no clock. Everything it needs comes in through `store` and `ctx`, so the
 * live API (SQL store), the importer (in-memory store) and the tests (array store) all run this exact code.
 * The database enforces R1–R4/R6 again as a backstop (database.md §4); this layer exists to say *why*,
 * naming the bookings in the way.
 */
import {
  DATE_MAX, DATE_MIN, HARD_HORIZON_YEARS, SOFT_HORIZON_YEARS,
  type Berth, type BookingInput, type Id, type ISODate, type ValidationResult, type Vessel, type Violation,
} from "@shared/contract";
import { addYears, diffDays, formatRange, isISODate } from "./dates";

/** An existing confirmed booking, as much as a message needs. */
export interface BookingRef {
  id: Id;
  title: string;          // vessel name or event/closure title
  berthName: string;
  startDate: ISODate;
  endDate: ISODate;
}

/** What the rules may ask about the world. Implemented by SQL (services) and in memory (importer, tests). */
export interface BookingStore {
  getBerth(id: Id): Promise<Berth | null>;
  getVessel(id: Id): Promise<Vessel | null>;
  /** Confirmed bookings on this berth touching [start, end] (inclusive), except `excludeId`. Sorted by start. */
  overlapping(berthId: Id, start: ISODate, end: ISODate, excludeId?: Id): Promise<BookingRef[]>;
  /** Confirmed bookings of this vessel, on any berth, touching [start, end], except `excludeId`. Sorted by start. */
  vesselBookings(vesselId: Id, start: ISODate, end: ISODate, excludeId?: Id): Promise<BookingRef[]>;
}

export interface RuleContext {
  source: "manual" | "import";
  asOfDate: ISODate;       // the project's "today"
  excludeId?: Id;          // the booking being edited: it can't conflict with itself
}

/** Thrown for ids that don't exist (→ 404), as opposed to rule violations (→ 409/422). */
export class UnknownEntityError extends Error {
  constructor(public entity: "berth" | "vessel", public id: Id) {
    super(`Unknown ${entity}: ${id}`);
  }
}

const MAX_NAMED = 3; // how many blocking bookings a message spells out before "and N more"

function describe(refs: BookingRef[], withBerth: boolean): string {
  const named = refs.slice(0, MAX_NAMED).map((r) =>
    `${r.title}${withBerth ? ` at ${r.berthName}` : ""} ${formatRange(r.startDate, r.endDate)}`);
  const more = refs.length > MAX_NAMED ? ` and ${refs.length - MAX_NAMED} more` : "";
  return named.join("; ") + more;
}

export async function validateBooking(
  input: BookingInput,
  store: BookingStore,
  ctx: RuleContext,
): Promise<Violation[]> {
  const out: Violation[] = [];
  const err = (v: Omit<Violation, "severity">) => out.push({ ...v, severity: "error" });
  const warn = (v: Omit<Violation, "severity">) => out.push({ ...v, severity: "warning" });
  const manual = ctx.source === "manual";

  // 1. R1 — a real, ordered range inside the sanity bounds. If it fails, date-based checks are skipped.
  const { startDate: s, endDate: e } = input;
  let rangeOk = true;
  if (!isISODate(s) || !isISODate(e)) {
    rangeOk = false;
    err({ code: "INVALID_RANGE", message: "Start and end must be real calendar dates (YYYY-MM-DD)." });
  } else if (e < s) {
    rangeOk = false;
    err({ code: "INVALID_RANGE", message: `End date ${e} is before start date ${s}.` });
  } else if (s < DATE_MIN || e > DATE_MAX) {
    rangeOk = false;
    err({ code: "INVALID_RANGE", message: `Dates must fall between ${DATE_MIN} and ${DATE_MAX}.` });
  }

  // 2. Occupant fields
  const isVessel = input.occupantType === "vessel";
  if (isVessel && !input.vesselId) {
    err({ code: "MISSING_FIELD", message: "Choose a vessel." });
  }
  if (!isVessel && !input.title?.trim()) {
    err({ code: "MISSING_FIELD", message: `An ${input.occupantType} needs a title.` });
  }

  // 3. Berth exists and is active (R5)
  const berth = await store.getBerth(input.berthId);
  if (!berth) throw new UnknownEntityError("berth", input.berthId);
  if (!berth.active) {
    err({ code: "BERTH_INACTIVE", message: `${berth.name} is inactive and takes no new bookings.` });
  }
  const exclusive = berth.kind === "berth";

  // 4–5. Vessel length known (manual only), then R3 fit (exclusive berths only)
  let vessel: Vessel | null = null;
  if (isVessel && input.vesselId) {
    vessel = await store.getVessel(input.vesselId);
    if (!vessel) throw new UnknownEntityError("vessel", input.vesselId);
    if (vessel.lengthFt == null) {
      if (manual) {
        err({ code: "VESSEL_LENGTH_UNKNOWN",
              message: `${vessel.name} has no length on record. Add its length before booking it.` });
      }
    } else if (exclusive && berth.lengthFt != null && vessel.lengthFt > berth.lengthFt) {
      const shortByFt = Math.round((vessel.lengthFt - berth.lengthFt) * 10) / 10;
      err({ code: "VESSEL_TOO_LONG",
            message: `${vessel.name} (${vessel.lengthFt}′) is ${shortByFt}′ too long for ${berth.name} (${berth.lengthFt}′).`,
            details: { vesselLengthFt: vessel.lengthFt, berthLengthFt: berth.lengthFt, shortByFt } });
    }
  }

  if (rangeOk) {
    // 6. R2 — no overlap on an exclusive berth (sections are shared)
    if (exclusive) {
      const clashes = await store.overlapping(berth.id, s, e, ctx.excludeId);
      if (clashes.length) {
        err({ code: "OVERLAP", bookingIds: clashes.map((c) => c.id),
              message: `${berth.name} is held by ${describe(clashes, false)}.` });
      }
    }

    // 7. R4 — the vessel is in one place at a time (sections included)
    if (vessel) {
      const elsewhere = await store.vesselBookings(vessel.id, s, e, ctx.excludeId);
      if (elsewhere.length) {
        err({ code: "VESSEL_DOUBLE_BERTHED", bookingIds: elsewhere.map((c) => c.id),
              message: `${vessel.name} is already booked: ${describe(elsewhere, true)}.` });
      }
    }

    if (manual) {
      // 8. Horizon — hard limit is an error, soft limit a "typo?" warning
      const hard = addYears(ctx.asOfDate, HARD_HORIZON_YEARS);
      const soft = addYears(ctx.asOfDate, SOFT_HORIZON_YEARS);
      if (e > hard) {
        err({ code: "BEYOND_HORIZON",
              message: `Bookings can end at most ${HARD_HORIZON_YEARS} years ahead (by ${hard}).` });
      } else if (e > soft) {
        const years = Math.floor(diffDays(ctx.asOfDate, e) / 365.25);
        warn({ code: "FAR_FUTURE", message: `This booking is ${years} years out. Typo?` });
      }

      // 9. In the past — allowed, flagged
      if (e < ctx.asOfDate) {
        warn({ code: "IN_PAST", message: `This booking ended before today (${ctx.asOfDate}).` });
      }
    }
  }

  return out;
}

export function toResult(violations: Violation[]): ValidationResult {
  return { ok: !violations.some((v) => v.severity === "error"), violations };
}

/** An array-backed store: the importer's staging store and the tests' fixture store. */
export class MemoryStore implements BookingStore {
  private bookings: (BookingRef & { berthId: Id; vesselId: Id | null })[] = [];
  constructor(private berths: Berth[], private vessels: Vessel[]) {}

  add(b: BookingRef & { berthId: Id; vesselId: Id | null }): void {
    this.bookings.push(b);
  }
  async getBerth(id: Id) { return this.berths.find((b) => b.id === id) ?? null; }
  async getVessel(id: Id) { return this.vessels.find((v) => v.id === id) ?? null; }
  async overlapping(berthId: Id, start: ISODate, end: ISODate, excludeId?: Id) {
    return this.find((b) => b.berthId === berthId, start, end, excludeId);
  }
  async vesselBookings(vesselId: Id, start: ISODate, end: ISODate, excludeId?: Id) {
    return this.find((b) => b.vesselId === vesselId, start, end, excludeId);
  }
  private find(match: (b: MemoryStore["bookings"][number]) => boolean, s: ISODate, e: ISODate, excludeId?: Id) {
    // Linear is fine: the importer keeps one store per project (a few thousand rows) — see database.md §7.
    return this.bookings
      .filter((b) => match(b) && b.id !== excludeId && b.startDate <= e && s <= b.endDate)
      .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
  }
}
