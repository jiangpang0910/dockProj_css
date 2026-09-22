// rules.ts against manual.md's worked examples (one test each) plus the edges around them.
import { describe, expect, it } from "vitest";
import type { Berth, BookingInput, Vessel } from "@shared/contract";
import { MemoryStore, UnknownEntityError, toResult, validateBooking, type RuleContext } from "@/server/domain/rules";
import { addYears, formatRange, isISODate, overlaps, spanDays } from "@/server/domain/dates";

const berth = (id: string, lengthFt: number | null, extra: Partial<Berth> = {}): Berth =>
  ({ id, name: id, lengthFt, active: true, sortOrder: 1, ...extra });
const vessel = (id: string, lengthFt: number | null): Vessel =>
  ({ id, name: id, lengthFt, draftFt: null, operator: null, notes: null });

const B = berth("B", 410), B55 = berth("B55", 55), B60 = berth("B60", 60), B2 = berth("B2", 410);
const SLIPS = berth("Slips", null), OFF = berth("Off", 100, { active: false });
const A = vessel("A", 100), C = vessel("C", 100), V60 = vessel("V60", 60), X = vessel("X", 20), Y = vessel("Y", 20);
const UNK = vessel("Unknown", null);

const TODAY = "2026-09-21";
const manual: RuleContext = { source: "manual", asOfDate: TODAY };
const imported: RuleContext = { source: "import", asOfDate: TODAY };

function store(...existing: { id: string; berth: Berth; vessel?: Vessel; s: string; e: string }[]) {
  const st = new MemoryStore([B, B55, B60, B2, SLIPS, OFF], [A, C, V60, X, Y, UNK]);
  for (const b of existing) {
    st.add({ id: b.id, title: b.vessel?.name ?? "Event", berthId: b.berth.id, berthName: b.berth.name,
             vesselId: b.vessel?.id ?? null, startDate: b.s, endDate: b.e });
  }
  return st;
}
const vb = (v: Vessel, b: Berth, s: string, e: string): BookingInput =>
  ({ berthId: b.id, occupantType: "vessel", vesselId: v.id, startDate: s, endDate: e });
const codes = async (input: BookingInput, st: MemoryStore, ctx = manual) =>
  (await validateBooking(input, st, ctx)).map((v) => v.code);

// dates in 2027 so the horizon/past warnings stay out of the way
const d = (day: number) => `2027-03-${String(day).padStart(2, "0")}`;
const A5to9 = store({ id: "a", berth: B, vessel: A, s: d(5), e: d(9) });

describe("manual.md worked examples", () => {
  it("adjacent, no shared day → OK", async () => {
    expect(await codes(vb(C, B, d(10), d(12)), A5to9)).toEqual([]);
  });
  it("shares the 9th → OVERLAP", async () => {
    expect(await codes(vb(C, B, d(9), d(12)), A5to9)).toEqual(["OVERLAP"]);
  });
  it("contained → OVERLAP", async () => {
    expect(await codes(vb(C, B, d(6), d(7)), A5to9)).toEqual(["OVERLAP"]);
  });
  it("identical → OVERLAP, naming the blocker", async () => {
    const [v] = await validateBooking(vb(C, B, d(5), d(9)), A5to9, manual);
    expect(v.code).toBe("OVERLAP");
    expect(v.bookingIds).toEqual(["a"]);
    expect(v.message).toBe("B is held by A 5–9 Mar 2027.");
  });
  it("cancelled booking occupies nothing → OK (a cancelled row is simply not in the store)", async () => {
    expect(await codes(vb(C, B, d(5), d(9)), store())).toEqual([]);
  });
  it("60′ vessel on a 55′ berth → VESSEL_TOO_LONG, short by 5′", async () => {
    const [v] = await validateBooking(vb(V60, B55, d(5), d(9)), store(), manual);
    expect(v.code).toBe("VESSEL_TOO_LONG");
    expect(v.details).toEqual({ vesselLengthFt: 60, berthLengthFt: 55, shortByFt: 5 });
  });
  it("equal length fits → OK", async () => {
    expect(await codes(vb(V60, B60, d(5), d(9)), store())).toEqual([]);
  });
  it("same vessel on another berth, overlapping → VESSEL_DOUBLE_BERTHED", async () => {
    const [v] = await validateBooking(vb(A, B2, d(8), d(10)), A5to9, manual);
    expect(v.code).toBe("VESSEL_DOUBLE_BERTHED");
    expect(v.message).toBe("A is already booked: A at B 5–9 Mar 2027.");
  });
  it("a berth with no length on record still holds one boat at a time → OVERLAP (imported: no fit check)", async () => {
    const st = store({ id: "x", berth: SLIPS, vessel: X, s: d(5), e: d(9) });
    expect(await codes(vb(Y, SLIPS, d(5), d(9)), st, imported)).toEqual(["OVERLAP"]);
  });
  it("9–5 → INVALID_RANGE", async () => {
    expect(await codes(vb(C, B, d(9), d(5)), store())).toEqual(["INVALID_RANGE"]);
  });
  it("unknown length, by hand → VESSEL_LENGTH_UNKNOWN", async () => {
    expect(await codes(vb(UNK, B, d(5), d(9)), store())).toEqual(["VESSEL_LENGTH_UNKNOWN"]);
  });
  it("past booking → saved with IN_PAST warning", async () => {
    const vs = await validateBooking(vb(C, B, "2019-03-01", "2019-03-05"), store(), manual);
    expect(vs.map((v) => [v.code, v.severity])).toEqual([["IN_PAST", "warning"]]);
    expect(toResult(vs).ok).toBe(true);
  });
});

describe("the rest of the rules", () => {
  it("collects every violation, not just the first", async () => {
    const st = store({ id: "a", berth: B55, vessel: A, s: d(5), e: d(9) },
                     { id: "v", berth: B2, vessel: V60, s: d(1), e: d(30) });
    expect(await codes(vb(V60, B55, d(6), d(7)), st)).toEqual(["VESSEL_TOO_LONG", "OVERLAP", "VESSEL_DOUBLE_BERTHED"]);
  });
  it("an edit doesn't conflict with itself (excludeId)", async () => {
    expect(await codes(vb(A, B, d(6), d(10)), A5to9, { ...manual, excludeId: "a" })).toEqual([]);
  });
  it("names at most 3 blockers, then 'and N more'", async () => {
    const st = store(...[1, 3, 5, 7, 9].map((n) => ({ id: `e${n}`, berth: B, s: d(n), e: d(n) })));
    const [v] = await validateBooking(vb(C, B, d(1), d(10)), st, manual);
    expect(v.bookingIds).toHaveLength(5);
    expect(v.message).toMatch(/and 2 more\.$/);
  });
  it("vessel is double-berthed even when the other booking is on a length-unknown berth", async () => {
    const st = store({ id: "s", berth: SLIPS, vessel: A, s: d(5), e: d(5) });
    expect(await codes(vb(A, B, d(5), d(6)), st)).toEqual(["VESSEL_DOUBLE_BERTHED"]);
  });
  it("berth with no length: by hand → BERTH_LENGTH_UNKNOWN; imported → booked, fit unverified", async () => {
    expect(await codes(vb(A, SLIPS, d(5), d(9)), store())).toEqual(["BERTH_LENGTH_UNKNOWN"]);
    expect(await codes(vb(A, SLIPS, d(5), d(9)), store(), imported)).toEqual([]);
  });
  it("inactive berth → BERTH_INACTIVE", async () => {
    expect(await codes(vb(C, OFF, d(5), d(9)), store())).toEqual(["BERTH_INACTIVE"]);
  });
  it("event needs a title; vessel booking needs a vessel", async () => {
    const ev: BookingInput = { berthId: "B", occupantType: "event", title: "  ", startDate: d(5), endDate: d(5) };
    expect(await codes(ev, store())).toEqual(["MISSING_FIELD"]);
    const nv: BookingInput = { berthId: "B", occupantType: "vessel", startDate: d(5), endDate: d(5) };
    expect(await codes(nv, store())).toEqual(["MISSING_FIELD"]);
  });
  it("closure blocks the berth like anything else", async () => {
    const cl: BookingInput = { berthId: "B", occupantType: "closure", title: "Crane work", startDate: d(8), endDate: d(8) };
    expect(await codes(cl, A5to9)).toEqual(["OVERLAP"]);
  });
  it("not a real date → INVALID_RANGE, and date checks are skipped", async () => {
    expect(await codes(vb(C, B, "2027-02-30", d(5)), A5to9)).toEqual(["INVALID_RANGE"]);
  });
  it("outside 1997–2050 → INVALID_RANGE", async () => {
    expect(await codes(vb(C, B, "2051-01-01", "2051-01-02"), store(), imported)).toEqual(["INVALID_RANGE"]);
  });
  it("unknown berth / vessel id → UnknownEntityError (404), not a violation", async () => {
    await expect(validateBooking(vb(C, berth("nope", 1), d(5), d(5)), store(), manual)).rejects.toBeInstanceOf(UnknownEntityError);
    await expect(validateBooking(vb(vessel("ghost", 1), B, d(5), d(5)), store(), manual)).rejects.toBeInstanceOf(UnknownEntityError);
  });
});

describe("horizon and imports", () => {
  it("≤ 2 years: nothing; 2–5 years: FAR_FUTURE warning; > 5 years: BEYOND_HORIZON", async () => {
    expect(await codes(vb(C, B, "2028-09-21", "2028-09-21"), store())).toEqual([]);
    const far = await validateBooking(vb(C, B, "2028-09-22", "2028-09-22"), store(), manual);
    expect(far.map((v) => [v.code, v.severity])).toEqual([["FAR_FUTURE", "warning"]]);
    expect(await codes(vb(C, B, "2031-09-21", "2031-09-21"), store())).toEqual(["FAR_FUTURE"]);
    expect(await codes(vb(C, B, "2031-09-22", "2031-09-22"), store())).toEqual(["BEYOND_HORIZON"]);
  });
  it("imports skip length-unknown, horizon and IN_PAST — but not R2/R3/R4", async () => {
    expect(await codes(vb(UNK, B, "2040-01-01", "2040-01-02"), store(), imported)).toEqual([]);
    expect(await codes(vb(C, B, "2001-01-01", "2001-01-02"), store(), imported)).toEqual([]);
    expect(await codes(vb(V60, B55, d(5), d(9)), store(), imported)).toEqual(["VESSEL_TOO_LONG"]);
    expect(await codes(vb(C, B, d(6), d(7)), A5to9, imported)).toEqual(["OVERLAP"]);
  });
});

describe("dates", () => {
  it("strict ISO dates", () => {
    expect(["2024-02-29", "2027-03-05"].every(isISODate)).toBe(true);
    expect(["2027-02-29", "2027-3-5", "2027-13-01", "", null].some(isISODate)).toBe(false);
  });
  it("addYears clamps Feb 29 → Feb 28", () => {
    expect(addYears("2024-02-29", 1)).toBe("2025-02-28");
    expect(addYears("2024-02-29", 4)).toBe("2028-02-29");
  });
  it("inclusive span and overlap", () => {
    expect(spanDays("2027-03-05", "2027-03-09")).toBe(5);
    expect(overlaps("2027-03-05", "2027-03-09", "2027-03-09", "2027-03-12")).toBe(true);
    expect(overlaps("2027-03-05", "2027-03-09", "2027-03-10", "2027-03-12")).toBe(false);
  });
  it("formatRange", () => {
    expect(formatRange("2027-03-05", "2027-03-05")).toBe("5 Mar 2027");
    expect(formatRange("2027-02-28", "2027-03-02")).toBe("28 Feb – 2 Mar 2027");
    expect(formatRange("2026-12-30", "2027-01-02")).toBe("30 Dec 2026 – 2 Jan 2027");
  });
});
