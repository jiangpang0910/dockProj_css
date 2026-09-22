// Auto-resolve: solve proposes (writes nothing), apply books only what the user confirmed, all or nothing.
// Runs the real Python CP-SAT solver (pipeline/docksolve) through the CLI, like the sample import test runs the parser.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ParsedWorkbook } from "@shared/pipeline";
import { freshDb } from "./helpers/db";
import { getDb } from "@/server/db/pool";
import { ApiErr } from "@/server/http/api-error";
import { toApiErr } from "@/server/http/route";
import { createProject } from "@/server/services/projects";
import { commitImport, uploadImport } from "@/server/services/imports";
import { dismissConflicts, listConflicts } from "@/server/services/conflicts";
import { createBooking, listBookings } from "@/server/services/bookings";
import { listBerths } from "@/server/services/berths";
import { applyProposals, solveConflicts } from "@/server/services/solve";

type Row = ParsedWorkbook["rows"][number];
const row = (berthLabel: string, occupantType: Row["occupantType"], title: string, s: string, e: string): Row =>
  ({ berthLabel, occupantType, title, startDate: s, endDate: e, notes: null, sheet: "2030", cell: null, classifiedBy: "regex" });
const book = (rows: Row[]): ParsedWorkbook => ({
  version: 1, format: "legacy_grid", stats: { sheets: 1, cells: rows.length, modelCalls: 0 },
  berths: [
    { name: "A", kind: "berth", lengthFt: 90, sortOrder: 1 },
    { name: "B", kind: "berth", lengthFt: 85, sortOrder: 2 },
    { name: "C", kind: "berth", lengthFt: 100, sortOrder: 3 },
  ],
  vessels: [
    { name: "R/V Eighty", lengthFt: 80, draftFt: null, operator: null, notes: null },
    { name: "R/V Big", lengthFt: 95, draftFt: null, operator: null, notes: null },
    { name: "R/V Huge", lengthFt: 150, draftFt: null, operator: null, notes: null },
    { name: "R/V Nolen", lengthFt: null, draftFt: null, operator: null, notes: null },
  ],
  rows, issues: [],
});

// Already on the schedule (fixed): A taken from 4 Jun, B all June, C 1–3 Jun.
const holders = book([
  row("A", "event", "Holder A", "2030-06-04", "2030-06-30"),
  row("B", "event", "Holder B", "2030-06-01", "2030-06-30"),
  row("C", "event", "Holder C", "2030-06-01", "2030-06-03"),
]);
// The second upload: every row is a conflict.
const claims = book([
  row("A", "vessel", "R/V Eighty", "2030-06-01", "2030-06-05"),  // A free 1–3, C free from 4 → split A 1–3, C 4–5
  row("B", "vessel", "R/V Big", "2030-07-01", "2030-07-03"),     // 95′ > B 85′ → only C fits, and C is free
  row("A", "vessel", "R/V Huge", "2030-08-01", "2030-08-02"),    // 150′: nothing is long enough
  row("A", "closure", "Crane work", "2030-06-10", "2030-06-11"), // closures are never moved
  row("A", "vessel", "R/V Nolen", "2030-06-12", "2030-06-13"),   // no length → can't prove a fit
]);

const YEAR = { from: "2030-01-01", to: "2030-12-31" };
let pid: string;
let berth: Record<string, string>;
const conflictId = async (title: string) => (await listConflicts(pid, { q: title })).items[0].id;
async function fails(p: Promise<unknown>): Promise<ApiErr> {
  try { await p; } catch (e) { return toApiErr(e); }
  throw new Error("expected a failure");
}

beforeAll(async () => { await freshDb(); }, 60_000);
beforeEach(async () => {
  await getDb().query("TRUNCATE project CASCADE");
  pid = (await createProject({ name: "Plan 2030", start: "empty", asOfDate: "2030-05-01" }, "editor")).id;
  for (const wb of [holders, claims]) {
    const run = await uploadImport(pid, "x.xlsx", new Uint8Array([1]), { parsed: wb, planTo: "2030-12-31" });
    await commitImport(pid, run.id);
  }
  berth = Object.fromEntries((await listBerths(pid)).map((b) => [b.name, b.id]));
});

describe("solve", () => {
  it("proposes placements for what it can, says why for the rest, and writes nothing", async () => {
    const before = (await listBookings(pid, YEAR)).length;
    const r = await solveConflicts(pid, { conflictIds: "all" });

    expect(r.status).toBe("OPTIMAL");
    expect(r.options).toEqual({ maxDelayDays: 3, maxEarlyDays: 0, maxMoves: 1, minSegmentDays: 2, timeLimitSec: 10,
      weights: { delay: 2, early: 3, move: 3 } });
    const seg = (t: string) => r.proposals.find((p) => p.title === t)!.segments.map((s) => [s.berthName, s.startDate, s.endDate]);
    expect(seg("R/V Eighty")).toEqual([["A", "2030-06-01", "2030-06-03"], ["C", "2030-06-04", "2030-06-05"]]);
    expect(seg("R/V Big")).toEqual([["C", "2030-07-01", "2030-07-03"]]);
    expect(r.proposals.find((p) => p.title === "R/V Big")).toMatchObject({
      requested: { berthId: berth.B, berthName: "B", startDate: "2030-07-01", endDate: "2030-07-03" },
      shiftDays: 0, cost: { delayDays: 0, earlyDays: 0, moves: 0, slackFootDays: 15, offRequestedDays: 3 },
    });
    expect(Object.fromEntries(r.unplaced.map((u) => [u.title, u.reason]))).toEqual({
      "R/V Huge": "NO_BERTH_LONG_ENOUGH", "Crane work": "CLOSURE", "R/V Nolen": "LENGTH_UNKNOWN" });
    expect(r.stats).toMatchObject({ selected: 5, considered: 2, placed: 2, unplaced: 3, moves: 1, delayDays: 0 });

    expect((await listBookings(pid, YEAR)).length).toBe(before);
    expect((await listConflicts(pid, {})).items).toHaveLength(5);
  }, 30_000);

  it("only looks at the conflicts it's given, and reports ones no longer open", async () => {
    const big = await conflictId("Big");
    const huge = await conflictId("Huge");
    await dismissConflicts(pid, { ids: [huge] });
    const r = await solveConflicts(pid, { conflictIds: [big, huge], options: { maxMoves: 0 } });
    expect(r.proposals.map((p) => p.title)).toEqual(["R/V Big"]);
    expect(r.unplaced).toEqual([{ conflictId: huge, title: "R/V Huge", reason: "NOT_OPEN", detail: "Already dismissed." }]);
    expect(r.options.maxMoves).toBe(0);
    expect(r.stats).toMatchObject({ selected: 2, placed: 1, unplaced: 1 });
  }, 30_000);
});

describe("apply", () => {
  it("books only the confirmed proposals: one now, the split one later", async () => {
    const r = await solveConflicts(pid, { conflictIds: "all" });
    const pick = (t: string) => {
      const p = r.proposals.find((x) => x.title === t)!;
      return { conflictId: p.conflictId, segments: p.segments.map(({ berthId, startDate, endDate }) => ({ berthId, startDate, endDate })) };
    };

    const one = await applyProposals(pid, { proposals: [pick("R/V Big")] });
    expect(one.placed).toBe(1);
    const placed = (await listConflicts(pid, { status: "placed" })).items;
    expect(placed.map((c) => [c.title, c.bookingIds.length, c.resolutionNote])).toEqual([["R/V Big", 1, "Auto-resolved"]]);
    expect(placed[0].bookingId).toBe(one.bookingIds[0]);
    expect((await listConflicts(pid, {})).items.map((c) => c.title)).toContain("R/V Eighty");  // untouched

    const two = await applyProposals(pid, { proposals: [pick("R/V Eighty")] });
    expect(two.bookingIds).toHaveLength(2);
    const eighty = (await listConflicts(pid, { status: "placed", q: "Eighty" })).items[0];
    expect(eighty.bookingIds).toEqual(two.bookingIds);
    expect(eighty.resolutionNote).toBe("Auto-resolved: split across 2 berths");
    const onSchedule = (await listBookings(pid, YEAR)).filter((b) => b.title === "R/V Eighty")
      .map((b) => [b.berthName, b.startDate, b.endDate]).sort();
    expect(onSchedule).toEqual([["A", "2030-06-01", "2030-06-03"], ["C", "2030-06-04", "2030-06-05"]]);
  }, 30_000);

  it("is all or nothing when the schedule changed since the solve", async () => {
    const r = await solveConflicts(pid, { conflictIds: "all" });
    const all = r.proposals.map((p) => ({ conflictId: p.conflictId, segments: p.segments }));
    // someone books C on 4–5 June in the meantime
    await createBooking(pid, { berthId: berth.C, occupantType: "event", vesselId: null, title: "Walk-in",
      startDate: "2030-06-04", endDate: "2030-06-05", notes: null });
    const e = await fails(applyProposals(pid, { proposals: all }));
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/^R\/V Eighty: .*Re-run auto-resolve\.$/);
    expect((await listConflicts(pid, { status: "placed" })).items).toEqual([]);  // Big wasn't placed either
    expect((await listConflicts(pid, {})).items).toHaveLength(5);
  }, 30_000);

  it("rejects a malformed or repeated batch, and conflicts already resolved", async () => {
    const big = await conflictId("Big");
    const seg = (s: string, e: string) => ({ berthId: berth.C, startDate: s, endDate: e });
    expect((await fails(applyProposals(pid, { proposals: [{ conflictId: big, segments: [seg("2030-07-01", "2030-07-01"), seg("2030-07-03", "2030-07-03")] }] }))).status).toBe(400);
    expect((await fails(applyProposals(pid, { proposals: [{ conflictId: big, segments: [seg("2030-07-01", "2030-07-01")] },
      { conflictId: big, segments: [seg("2030-07-02", "2030-07-02")] }] }))).status).toBe(400);
    // the rules still apply: Big (95′) doesn't fit A (90′)
    expect((await fails(applyProposals(pid, { proposals: [{ conflictId: big, segments: [{ ...seg("2030-07-01", "2030-07-03"), berthId: berth.A }] }] }))).status).toBe(422);
    await applyProposals(pid, { proposals: [{ conflictId: big, segments: [seg("2030-07-01", "2030-07-03")] }] });
    const again = await fails(applyProposals(pid, { proposals: [{ conflictId: big, segments: [seg("2030-07-10", "2030-07-12")] }] }));
    expect(again.status).toBe(409);
    expect(again.message).toMatch(/already placed/);
  }, 30_000);
});
