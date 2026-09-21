// Mock-only port of src/server/domain/rules.ts (same order, same codes, same messages) so the live-validation
// panel behaves like the real API. Server code is never imported into the client bundle.
import {
  DATE_MAX, DATE_MIN, HARD_HORIZON_YEARS, SOFT_HORIZON_YEARS,
  type Berth, type Booking, type BookingInput, type ISODate, type Vessel, type Violation,
} from "@shared/contract";
import { addYears, diffDays, formatRange, isISODate } from "@/lib/dates";

export interface MockWorld { berths: Berth[]; vessels: Vessel[]; bookings: Booking[] }
export class UnknownEntity extends Error { constructor(public entity: string) { super(`Unknown ${entity}`); } }

const titleOf = (w: MockWorld, b: Booking) => (b.vesselId ? w.vessels.find((v) => v.id === b.vesselId)?.name ?? b.title : b.title);
const berthName = (w: MockWorld, id: string) => w.berths.find((b) => b.id === id)?.name ?? "?";

function describe(w: MockWorld, refs: Booking[], withBerth: boolean) {
  const named = refs.slice(0, 3).map((r) => `${titleOf(w, r)}${withBerth ? ` at ${berthName(w, r.berthId)}` : ""} ${formatRange(r.startDate, r.endDate)}`);
  return named.join("; ") + (refs.length > 3 ? ` and ${refs.length - 3} more` : "");
}

export function validate(input: BookingInput, w: MockWorld, ctx: { source: "manual" | "import"; asOfDate: ISODate; excludeId?: string }): Violation[] {
  const out: Violation[] = [];
  const err = (v: Omit<Violation, "severity">) => out.push({ ...v, severity: "error" });
  const warn = (v: Omit<Violation, "severity">) => out.push({ ...v, severity: "warning" });
  const manual = ctx.source === "manual";
  const s = input.startDate, e = input.endDate;
  let rangeOk = true;
  if (!isISODate(s) || !isISODate(e)) { rangeOk = false; err({ code: "INVALID_RANGE", message: "Start and end must be real calendar dates (YYYY-MM-DD)." }); }
  else if (e < s) { rangeOk = false; err({ code: "INVALID_RANGE", message: `End date ${e} is before start date ${s}.` }); }
  else if (s < DATE_MIN || e > DATE_MAX) { rangeOk = false; err({ code: "INVALID_RANGE", message: `Dates must fall between ${DATE_MIN} and ${DATE_MAX}.` }); }

  const isVessel = input.occupantType === "vessel";
  if (isVessel && !input.vesselId) err({ code: "MISSING_FIELD", message: "Choose a vessel." });
  if (!isVessel && !input.title?.trim()) err({ code: "MISSING_FIELD", message: `An ${input.occupantType} needs a title.` });

  const berth = w.berths.find((b) => b.id === input.berthId);
  if (!berth) throw new UnknownEntity("berth");
  if (!berth.active) err({ code: "BERTH_INACTIVE", message: `${berth.name} is inactive and takes no new bookings.` });
  const exclusive = berth.kind === "berth";

  let vessel: Vessel | undefined;
  if (isVessel && input.vesselId) {
    vessel = w.vessels.find((v) => v.id === input.vesselId);
    if (!vessel) throw new UnknownEntity("vessel");
    if (vessel.lengthFt == null) {
      if (manual) err({ code: "VESSEL_LENGTH_UNKNOWN", message: `${vessel.name} has no length on record. Add its length before booking it.` });
    } else if (exclusive && berth.lengthFt != null && vessel.lengthFt > berth.lengthFt) {
      const shortByFt = Math.round((vessel.lengthFt - berth.lengthFt) * 10) / 10;
      err({ code: "VESSEL_TOO_LONG", message: `${vessel.name} (${vessel.lengthFt}′) is ${shortByFt}′ too long for ${berth.name} (${berth.lengthFt}′).`,
            details: { vesselLengthFt: vessel.lengthFt, berthLengthFt: berth.lengthFt, shortByFt } });
    }
  }

  if (rangeOk) {
    const live = w.bookings.filter((b) => b.status === "confirmed" && b.id !== ctx.excludeId && b.startDate <= e && s <= b.endDate)
      .sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
    if (exclusive) {
      const clashes = live.filter((b) => b.berthId === berth.id);
      if (clashes.length) err({ code: "OVERLAP", bookingIds: clashes.map((c) => c.id), message: `${berth.name} is held by ${describe(w, clashes, false)}.` });
    }
    if (vessel) {
      const elsewhere = live.filter((b) => b.vesselId === vessel!.id);
      if (elsewhere.length) err({ code: "VESSEL_DOUBLE_BERTHED", bookingIds: elsewhere.map((c) => c.id), message: `${vessel.name} is already booked: ${describe(w, elsewhere, true)}.` });
    }
    if (manual) {
      const hard = addYears(ctx.asOfDate, HARD_HORIZON_YEARS), soft = addYears(ctx.asOfDate, SOFT_HORIZON_YEARS);
      if (e > hard) err({ code: "BEYOND_HORIZON", message: `Bookings can end at most ${HARD_HORIZON_YEARS} years ahead (by ${hard}).` });
      else if (e > soft) warn({ code: "FAR_FUTURE", message: `This booking is ${Math.floor(diffDays(ctx.asOfDate, e) / 365.25)} years out. Typo?` });
      if (e < ctx.asOfDate) warn({ code: "IN_PAST", message: `This booking ended before today (${ctx.asOfDate}).` });
    }
  }
  return out;
}
