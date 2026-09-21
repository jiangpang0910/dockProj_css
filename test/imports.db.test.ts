// Import: planning window, staging through rules.ts, commit, discard, triage. Fixture workbooks keep it fast;
// one test runs the real Python pipeline on the sample workbook.
import fs from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ParsedWorkbook } from "@shared/pipeline";
import { freshDb } from "./helpers/db";
import { getDb } from "@/server/db/pool";
import { ApiErr } from "@/server/http/api-error";
import { toApiErr } from "@/server/http/route";
import { createProject } from "@/server/services/projects";
import { commitImport, discardImport, listIssues, resolveIssue, uploadImport } from "@/server/services/imports";
import { conflictSummary, dismissConflicts, listConflicts, resolveConflict } from "@/server/services/conflicts";
import { cancelBooking } from "@/server/services/bookings";
import { listBerths } from "@/server/services/berths";
import { listVessels } from "@/server/services/vessels";
import { listBookings } from "@/server/services/bookings";

const row = (berthLabel: string | null, occupantType: "vessel" | "event" | "closure", title: string, s: string, e: string, cell = "B2") =>
  ({ berthLabel, occupantType, title, startDate: s, endDate: e, notes: null, sheet: s.slice(0, 4), cell, classifiedBy: "regex" as const });

/** Planning 27 Apr 2008 – 15 Jan 2009 over a file that spans 2007–2010. */
const grid: ParsedWorkbook = {
  version: 1, format: "legacy_grid", stats: { sheets: 4, cells: 900, modelCalls: 0 },
  berths: [
    { name: "North Pier West", kind: "berth", lengthFt: 410, sortOrder: 1 },
    { name: "South Float East", kind: "berth", lengthFt: 90, sortOrder: 2 },
    { name: "Small Craft Slips", kind: "section", lengthFt: null, sortOrder: 3 },
  ],
  vessels: [
    { name: "R/V High Drift", lengthFt: 120, draftFt: null, operator: null, notes: null },
    { name: "S/V Small", lengthFt: 60, draftFt: null, operator: null, notes: null },
    { name: "F/V Never Used", lengthFt: 30, draftFt: null, operator: null, notes: null },
  ],
  rows: [
    row("North Pier West", "vessel", "R/V High Drift", "2007-06-01", "2007-06-05"),          // before the window
    row("North Pier West", "vessel", "R/V High Drift", "2008-04-20", "2008-04-28"),          // straddles `from` → kept
    row("North Pier West", "vessel", "S/V Small", "2008-04-28", "2008-04-30", "C3"),         // overlaps the one above → conflict
    row("South Float East", "vessel", "R/V High Drift", "2008-06-01", "2008-06-03", "D4"),   // 120 > 90 → conflict
    row("South Float East", "vessel", "M/V Mystery", "2008-07-01", "2008-07-02"),            // unknown vessel → created, length unknown
    row("Small Craft Slips", "event", "Sea Scouts", "2008-07-01", "2008-07-02"),
    row("Small Craft Slips", "event", "Regatta", "2008-07-01", "2008-07-02"),               // sections are shared
    row("North Pier West", "closure", "Crane work", "2010-03-01", "2010-03-02"),             // after the window
  ],
  issues: [
    { code: "NO_BERTH", severity: "error", sheet: "2008", cell: "F9", message: "Row has no berth label.",
      row: row(null, "vessel", "S/V Small", "2008-08-01", "2008-08-03", "F9") },
    { code: "NO_BERTH", severity: "error", sheet: "1999", cell: "A1", message: "Old and irrelevant.",
      row: row(null, "event", "Old", "1999-05-01", "1999-05-01") },                           // outside → dropped
    { code: "HEADER_YEAR_MISMATCH", severity: "info", sheet: "2010", cell: "A40", message: "Year inferred.", row: null },
  ],
};

let pid: string;
beforeAll(async () => { await freshDb(); }, 60_000);
beforeEach(async () => {
  await getDb().query("TRUNCATE project CASCADE");
  pid = (await createProject({ name: "Plan 2008", start: "empty", asOfDate: "2008-04-27" })).id;
});

const bytes = new Uint8Array([1, 2, 3]);
async function fails(p: Promise<unknown>): Promise<ApiErr> {
  try { await p; } catch (e) { return toApiErr(e); }
  throw new Error("expected a failure");
}

describe("upload → preview", () => {
  it("keeps only rows touching the window, stages the rest, and unplaceable rows become conflicts (not issues)", async () => {
    const run = await uploadImport(pid, "grid.xlsx", bytes, { parsed: grid, planTo: "2009-01-15" });
    expect(run.window).toEqual({ from: "2008-04-27", to: "2009-01-15" });
    expect(run.status).toBe("previewed");
    expect(run.counts).toMatchObject({ sheets: 4, cells: 900, berths: 3, bookings: 4, outsideWindow: 2, issues: 1, conflicts: 3 });
    expect(run.counts.vessels).toBe(3);   // High Drift + Mystery + S/V Small (its claims are conflicts); Never Used unused
    expect(run.conflictCounts).toEqual({ OVERLAP: 1, VESSEL_TOO_LONG: 1, NO_BERTH: 1 });
    expect((await listIssues(pid, run.id, {})).items.map((i) => i.code)).toEqual(["HEADER_YEAR_MISMATCH"]);
    // staged conflicts aren't on the Conflicts tab until commit; nothing is live yet
    expect((await listConflicts(pid, {})).items).toEqual([]);
    expect(await listBerths(pid)).toHaveLength(0);
  });

  it("default window is today → +5 years; a planTo before today is refused", async () => {
    const run = await uploadImport(pid, "grid.xlsx", bytes, { parsed: grid });
    expect(run.window).toEqual({ from: "2008-04-27", to: "2013-04-27" });
    expect(run.counts.outsideWindow).toBe(1);
    expect((await fails(uploadImport(pid, "g.xlsx", bytes, { parsed: grid, planTo: "2008-01-01" }))).status).toBe(400);
  });

  it("an unrecognised file → 422, nothing stored", async () => {
    const unknown: ParsedWorkbook = { ...grid, format: null, rows: [], berths: [], vessels: [],
      issues: [{ code: "UNKNOWN_FORMAT", severity: "error", sheet: "Sheet1", cell: null, message: "Not a dock file.", row: null }] };
    expect((await fails(uploadImport(pid, "x.xlsx", bytes, { parsed: unknown }))).message).toBe("Not a dock file.");
  });
});

describe("commit, discard, triage", () => {
  it("commit creates berths, vessels and bookings; a second commit → 409", async () => {
    const run = await uploadImport(pid, "grid.xlsx", bytes, { parsed: grid, planTo: "2009-01-15" });
    const done = await commitImport(pid, run.id);
    expect(done.status).toBe("committed");
    expect((await listBerths(pid)).map((b) => b.name)).toEqual(["North Pier West", "South Float East", "Small Craft Slips"]);
    expect((await listVessels(pid)).map((v) => [v.name, v.lengthFt])).toEqual([["M/V Mystery", null], ["R/V High Drift", 120], ["S/V Small", 60]]);
    const live = await listBookings(pid, { from: "2008-01-01", to: "2008-12-31" });
    expect(live.map((b) => [b.title, b.source])).toEqual([
      ["R/V High Drift", "import"], ["Regatta", "import"], ["Sea Scouts", "import"], ["M/V Mystery", "import"]]);
    expect((await fails(commitImport(pid, run.id))).status).toBe(409);
  });

  it("re-importing the same file adds nothing new: exact repeats become DUPLICATE_EXISTING", async () => {
    await commitImport(pid, (await uploadImport(pid, "a.xlsx", bytes, { parsed: grid, planTo: "2009-01-15" })).id);
    const again = await uploadImport(pid, "a.xlsx", bytes, { parsed: grid, planTo: "2009-01-15" });
    expect(again.counts).toMatchObject({ berths: 0, vessels: 0, bookings: 0 });
    const codes = (await listIssues(pid, again.id, { code: "DUPLICATE_EXISTING" })).items;
    expect(codes).toHaveLength(4);
  });

  it("discard drops staged rows and staged conflicts; nothing goes live", async () => {
    const run = await uploadImport(pid, "grid.xlsx", bytes, { parsed: grid, planTo: "2009-01-15" });
    await discardImport(pid, run.id);
    expect((await fails(commitImport(pid, run.id))).status).toBe(409);
    expect(await listBerths(pid)).toHaveLength(0);
    expect((await conflictSummary(pid)).open).toBe(0);
  });

  it("resolve an issue: create_booking needs a committed import; dismiss works any time", async () => {
    const withCell: ParsedWorkbook = { ...grid, issues: [...grid.issues,
      { code: "UNPARSEABLE_CELL", severity: "warning", sheet: "2008", cell: "G7", message: "Couldn't tell.",
        row: row("South Float East", "event", "Mystery thing", "2008-09-01", "2008-09-01", "G7") }] };
    const run = await uploadImport(pid, "grid.xlsx", bytes, { parsed: withCell, planTo: "2009-01-15" });
    const cell = (await listIssues(pid, run.id, { code: "UNPARSEABLE_CELL" })).items[0];
    expect((await fails(resolveIssue(pid, run.id, cell.id, { action: "create_booking", berthId: crypto.randomUUID() }))).status).toBe(409);
    await commitImport(pid, run.id);
    const sfe = (await listBerths(pid)).find((b) => b.name === "South Float East")!;
    expect(await resolveIssue(pid, run.id, cell.id, { action: "create_booking", berthId: sfe.id })).toMatchObject({ resolution: "created" });
    const hdr = (await listIssues(pid, run.id, { code: "HEADER_YEAR_MISMATCH" })).items[0];
    expect((await resolveIssue(pid, run.id, hdr.id, { action: "dismiss" })).resolution).toBe("dismissed");
    expect((await fails(resolveIssue(pid, run.id, hdr.id, { action: "dismiss" }))).status).toBe(409);
  });
});

describe("conflicts", () => {
  async function committed() {
    const run = await uploadImport(pid, "grid.xlsx", bytes, { parsed: grid, planTo: "2009-01-15" });
    await commitImport(pid, run.id);
    const berths = await listBerths(pid);
    const id = (n: string) => berths.find((b) => b.name === n)!.id;
    return { run, npw: id("North Pier West"), sfe: id("South Float East") };
  }

  it("go live on commit, typed, earliest first, with the live booking in the way", async () => {
    const { run, npw } = await committed();
    const list = (await listConflicts(pid, {})).items;
    expect(list.map((c) => [c.type, c.title, c.startDate])).toEqual([
      ["OVERLAP", "S/V Small", "2008-04-28"], ["VESSEL_TOO_LONG", "R/V High Drift", "2008-06-01"], ["NO_BERTH", "S/V Small", "2008-08-01"]]);
    const [overlap, tooLong, noBerth] = list;
    expect(overlap).toMatchObject({ status: "open", importId: run.id, berthId: npw, berthName: "North Pier West", vesselLengthFt: 60, cell: "C3" });
    expect(overlap.blockers).toEqual([{ bookingId: expect.any(String), title: "R/V High Drift", berthName: "North Pier West",
      startDate: "2008-04-20", endDate: "2008-04-28" }]);
    expect(tooLong).toMatchObject({ vesselLengthFt: 120, berthLengthFt: 90, blockers: [] });
    expect(noBerth).toMatchObject({ berthId: null, berthLabel: null });
    expect(await conflictSummary(pid)).toEqual({
      open: 3, placed: 0, dismissed: 0,
      byType: { OVERLAP: 1, VESSEL_TOO_LONG: 1, VESSEL_DOUBLE_BERTHED: 0, NO_BERTH: 1, BERTH_INACTIVE: 0 },
      byBerth: [{ berthId: npw, berthName: "North Pier West", open: 1 }, { berthId: expect.any(String), berthName: "South Float East", open: 1 },
        { berthId: null, berthName: null, open: 1 }],
    });
    expect((await listConflicts(pid, { type: "NO_BERTH" })).items).toHaveLength(1);
    expect((await listConflicts(pid, { q: "drift" })).items.map((c) => c.type)).toEqual(["VESSEL_TOO_LONG"]);
  });

  it("place runs the normal rules: still-blocked → 409 and stays open; elsewhere or on new days → placed", async () => {
    const { npw, sfe } = await committed();
    const [overlap, tooLong] = (await listConflicts(pid, {})).items;
    expect((await fails(resolveConflict(pid, overlap.id, { action: "place", berthId: npw }))).status).toBe(409);
    expect((await fails(resolveConflict(pid, tooLong.id, { action: "place", berthId: sfe }))).status).toBe(422);

    const placed = await resolveConflict(pid, overlap.id, { action: "place", berthId: npw, startDate: "2008-04-29" });
    expect(placed).toMatchObject({ status: "placed", bookingId: expect.any(String), resolvedAt: expect.any(String) });
    const live = await listBookings(pid, { from: "2008-04-29", to: "2008-04-30", berthId: npw });
    expect(live.map((b) => [b.title, b.startDate, b.endDate])).toEqual([["S/V Small", "2008-04-29", "2008-04-30"]]);
    expect((await resolveConflict(pid, tooLong.id, { action: "place", berthId: npw })).status).toBe("placed");
    expect((await fails(resolveConflict(pid, tooLong.id, { action: "dismiss" }))).status).toBe(409);
    expect(await conflictSummary(pid)).toMatchObject({ open: 1, placed: 2 });
  });

  it("blockers are live: cancelling the booking in the way clears them", async () => {
    const { npw } = await committed();
    const overlap = (await listConflicts(pid, { type: "OVERLAP" })).items[0];
    const blocker = (await listBookings(pid, { from: "2008-04-20", to: "2008-04-28", berthId: npw }))[0];
    await cancelBooking(pid, blocker.id, blocker.version);
    expect((await listConflicts(pid, { type: "OVERLAP" })).items[0].blockers).toEqual([]);
    expect((await resolveConflict(pid, overlap.id, { action: "place", berthId: npw })).status).toBe("placed");
  });

  it("dismiss one with a reason, or a whole type at once", async () => {
    await committed();
    const noBerth = (await listConflicts(pid, { type: "NO_BERTH" })).items[0];
    expect(await resolveConflict(pid, noBerth.id, { action: "dismiss", reason: "historical" }))
      .toMatchObject({ status: "dismissed", resolutionNote: "historical" });
    expect(await dismissConflicts(pid, { type: "OVERLAP" })).toEqual({ dismissed: 1 });
    expect(await dismissConflicts(pid, { type: "OVERLAP" })).toEqual({ dismissed: 0 });
    expect((await listConflicts(pid, { status: "dismissed" })).items).toHaveLength(2);
    expect((await conflictSummary(pid)).byType.VESSEL_TOO_LONG).toBe(1);
  });

  it("page with a cursor", async () => {
    await committed();
    const p1 = await listConflicts(pid, { limit: 2 });
    expect(p1.items).toHaveLength(2);
    const p2 = await listConflicts(pid, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((c) => c.type)).toEqual(["NO_BERTH"]);
    expect(p2.nextCursor).toBeNull();
  });

  it("a cloned project gets its template's open conflicts, pointing at its own berths", async () => {
    await committed();
    await getDb().query("UPDATE project SET template_key = 'sample' WHERE id = $1", [pid]);
    const clone = await createProject({ name: "Mine", start: "sample" });
    const mine = (await listConflicts(clone.id, {})).items;
    expect(mine.map((c) => c.type)).toEqual(["OVERLAP", "VESSEL_TOO_LONG", "NO_BERTH"]);
    const cloneNpw = (await listBerths(clone.id)).find((b) => b.name === "North Pier West")!.id;
    expect(mine[0]).toMatchObject({ berthId: cloneNpw, importId: null, blockers: [expect.objectContaining({ title: "R/V High Drift" })] });
    expect((await fails(resolveConflict(pid, mine[0].id, { action: "dismiss" }))).status).toBe(403); // template is read-only
  });
});

describe("template format", () => {
  it("brings in the whole Vessels sheet; existing names are kept and noted", async () => {
    const tpl: ParsedWorkbook = {
      version: 1, format: "template", stats: { sheets: 3, cells: 40, modelCalls: 0 },
      berths: [{ name: "Dock A", kind: "berth", lengthFt: 100, sortOrder: 1 }],
      vessels: [
        { name: "R/V One", lengthFt: 80, draftFt: 5, operator: "WHOI", notes: null },
        { name: "R/V Two", lengthFt: 40, draftFt: null, operator: null, notes: null },
      ],
      rows: [{ ...row("Dock A", "vessel", "R/V One", "2008-05-01", "2008-05-03"), classifiedBy: "template", sheet: "Bookings" }],
      issues: [],
    };
    await commitImport(pid, (await uploadImport(pid, "t.xlsx", bytes, { parsed: tpl })).id);
    expect((await listVessels(pid)).map((v) => [v.name, v.operator])).toEqual([["R/V One", "WHOI"], ["R/V Two", null]]);
    const again = await uploadImport(pid, "t.xlsx", bytes, { parsed: tpl });
    const dup = (await listIssues(pid, again.id, { code: "DUPLICATE_EXISTING" })).items;
    expect(dup).toHaveLength(4); // 1 berth + 2 vessels + 1 booking
  });
});

describe("deleting a project", () => {
  it("works after imports whose staged rows point at existing berths (0005)", async () => {
    for (let i = 0; i < 2; i++) {  // the 2nd upload stages against the berths the 1st one created
      const run = await uploadImport(pid, "grid.xlsx", bytes, { parsed: grid, planTo: "2009-01-15" });
      await commitImport(pid, run.id);
    }
    const { deleteProject } = await import("@/server/services/projects");
    await deleteProject(pid);
    expect((await getDb().query("SELECT count(*)::int AS n FROM project WHERE id = $1", [pid])).rows[0]).toEqual({ n: 0 });
    // PGlite happens to order the cascades so the old FK passed here; Neon didn't. Pin the rule itself.
    const { rows } = await getDb().query<{ r: string }>(
      "SELECT confdeltype AS r FROM pg_constraint WHERE conname = 'import_staged_booking_berth_id_fkey'");
    expect(rows).toEqual([{ r: "c" }]);
  });
});

const SAMPLE = "sample_data/Dock Schedule - Synthetic Sample.xlsx";
describe.skipIf(!fs.existsSync("pipeline/cli.py"))("the real pipeline (slow)", () => {
  it("imports the sample workbook end to end, full window, and the result audits clean", async () => {
    const { runAudit } = await import("@/server/services/audit");
    const run = await uploadImport(pid, "sample.xlsx", new Uint8Array(fs.readFileSync(SAMPLE)), { fullWindow: true, noModel: true });
    expect(run.format).toBe("legacy_grid");
    expect(run.counts.berths).toBe(8);
    expect(run.counts.bookings).toBeGreaterThan(1500);
    expect(run.counts.conflicts).toBeGreaterThan(150);          // mostly NO_BERTH (overflow rows under South Float East)
    await commitImport(pid, run.id);
    expect((await conflictSummary(pid)).open).toBe(run.counts.conflicts);
    const audit = await runAudit(pid);
    expect(audit.violations).toEqual([]);
    expect(audit.checkedBookings).toBe(run.counts.bookings);
  }, 120_000);
});

describe.skipIf(!fs.existsSync("pipeline/cli.py"))("a filled-in dock-template.xlsx through the real pipeline (slow)", () => {
  it("sets up berths, vessels and bookings in an empty project, flagging the bad rows", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile("public/dock-template.xlsx");
    wb.getWorksheet("Berths")!.addRows([["Dock A", "berth", 100, 1], ["Slips", "section", null, 2]]);
    wb.getWorksheet("Vessels")!.addRows([["R/V Fits", 80, null, null, null], ["R/V Too Big", 150, null, null, null]]);
    wb.getWorksheet("Bookings")!.addRows([
      ["Dock A", "vessel", "R/V Fits", new Date(Date.UTC(2008, 5, 1)), new Date(Date.UTC(2008, 5, 3)), null],
      ["Dock A", "vessel", "R/V Too Big", "2008-07-01", "2008-07-02", null],
      ["Slips", "event", "Sea Scouts", "2008-06-02", "2008-06-02", null],
    ]);
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
    const run = await uploadImport(pid, "mine.xlsx", bytes, { noModel: true, planTo: "2009-01-15" });
    expect(run.format).toBe("template");
    expect(run.counts).toMatchObject({ berths: 2, vessels: 2, bookings: 2 });
    expect((await listIssues(pid, run.id, {})).items).toEqual([]);
    expect(run.conflictCounts).toEqual({ VESSEL_TOO_LONG: 1 });
    await commitImport(pid, run.id);
    const live = await listBookings(pid, { from: "2008-01-01", to: "2008-12-31" });
    expect(live.map((b) => [b.title, b.startDate, b.endDate])).toEqual([
      ["R/V Fits", "2008-06-01", "2008-06-03"], ["Sea Scouts", "2008-06-02", "2008-06-02"]]);
  }, 60_000);
});
