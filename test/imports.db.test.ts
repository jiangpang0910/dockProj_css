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
    row("North Pier West", "vessel", "S/V Small", "2008-04-28", "2008-04-30", "C3"),         // overlaps the one above → issue
    row("South Float East", "vessel", "R/V High Drift", "2008-06-01", "2008-06-03", "D4"),   // 120 > 90 → issue
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
beforeAll(async () => { await freshDb(); });
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
  it("keeps only rows touching the window, flags violations, stages the rest", async () => {
    const run = await uploadImport(pid, "grid.xlsx", bytes, { parsed: grid, planTo: "2009-01-15" });
    expect(run.window).toEqual({ from: "2008-04-27", to: "2009-01-15" });
    expect(run.status).toBe("previewed");
    expect(run.counts).toMatchObject({ sheets: 4, cells: 900, berths: 3, bookings: 4, outsideWindow: 2 });
    expect(run.counts.vessels).toBe(2);   // High Drift + Mystery; S/V Small only in a failed row; Never Used unused
    const issues = (await listIssues(pid, run.id, {})).items;
    expect(issues.map((i) => i.code).sort()).toEqual(["HEADER_YEAR_MISMATCH", "NO_BERTH", "OVERLAP", "VESSEL_TOO_LONG"]);
    const tooLong = issues.find((i) => i.code === "VESSEL_TOO_LONG")!;
    expect(tooLong.row).toMatchObject({ berthLabel: "South Float East", title: "R/V High Drift", vesselLengthFt: 120 });
    expect(tooLong.cell).toBe("D4");
    // nothing is live yet
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
    expect((await listVessels(pid)).map((v) => [v.name, v.lengthFt])).toEqual([["M/V Mystery", null], ["R/V High Drift", 120]]);
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

  it("discard drops staged rows; nothing goes live", async () => {
    const run = await uploadImport(pid, "grid.xlsx", bytes, { parsed: grid, planTo: "2009-01-15" });
    await discardImport(pid, run.id);
    expect((await fails(commitImport(pid, run.id))).status).toBe(409);
    expect(await listBerths(pid)).toHaveLength(0);
  });

  it("resolve: create_booking needs a committed import, then runs the normal rules; dismiss works any time", async () => {
    const run = await uploadImport(pid, "grid.xlsx", bytes, { parsed: grid, planTo: "2009-01-15" });
    const all = (await listIssues(pid, run.id, {})).items;
    const noBerth = all.find((i) => i.code === "NO_BERTH")!;
    const overlap = all.find((i) => i.code === "OVERLAP")!;

    const anyBerth = crypto.randomUUID();
    expect((await fails(resolveIssue(pid, run.id, noBerth.id, { action: "create_booking", berthId: anyBerth }))).status).toBe(409);
    await commitImport(pid, run.id);
    const berths = await listBerths(pid);
    const sfe = berths.find((b) => b.name === "South Float East")!;
    const npwId = berths.find((b) => b.name === "North Pier West")!.id;

    const created = await resolveIssue(pid, run.id, noBerth.id, { action: "create_booking", berthId: sfe.id, vesselLengthFt: 60 });
    expect(created).toMatchObject({ resolved: true, resolution: "created" });
    expect((await listVessels(pid, { q: "small" }))[0].lengthFt).toBe(60);

    // the overlap row still clashes on its original berth → the usual 409, issue stays open
    const clash = await fails(resolveIssue(pid, run.id, overlap.id, { action: "create_booking", berthId: npwId }));
    expect(clash.status).toBe(409);
    expect((await listIssues(pid, run.id, { resolved: false, code: "OVERLAP" })).items).toHaveLength(1);

    const dismissed = await resolveIssue(pid, run.id, overlap.id, { action: "dismiss", reason: "historical" });
    expect(dismissed.resolution).toBe("dismissed");
    expect((await fails(resolveIssue(pid, run.id, overlap.id, { action: "dismiss" }))).status).toBe(409);
  });

  it("issues page with a cursor", async () => {
    const run = await uploadImport(pid, "grid.xlsx", bytes, { parsed: grid, planTo: "2009-01-15" });
    const p1 = await listIssues(pid, run.id, { limit: 3 });
    expect(p1.items).toHaveLength(3);
    expect(p1.items[0].severity).toBe("error");
    const p2 = await listIssues(pid, run.id, { limit: 3, cursor: p1.nextCursor! });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
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

const SAMPLE = "sample_data/Dock Schedule - Synthetic Sample.xlsx";
describe.skipIf(!fs.existsSync("pipeline/cli.py"))("the real pipeline (slow)", () => {
  it("imports the sample workbook end to end, full window, and the result audits clean", async () => {
    const { runAudit } = await import("@/server/services/audit");
    const run = await uploadImport(pid, "sample.xlsx", new Uint8Array(fs.readFileSync(SAMPLE)), { fullWindow: true, noModel: true });
    expect(run.format).toBe("legacy_grid");
    expect(run.counts.berths).toBe(8);
    expect(run.counts.bookings).toBeGreaterThan(1500);
    await commitImport(pid, run.id);
    const audit = await runAudit(pid);
    expect(audit.violations).toEqual([]);
    expect(audit.checkedBookings).toBe(run.counts.bookings);
  }, 120_000);
});
