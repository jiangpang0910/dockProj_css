// Service-level tests on a real (in-process) Postgres: the services, rules.ts and the constraints together.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./helpers/db";
import { makeProject } from "./helpers/seed";
import { getDb } from "@/server/db/pool";
import { ApiErr } from "@/server/http/api-error";
import { toApiErr } from "@/server/http/route";
import { cancelBooking, createBooking, getSchedule, listBookings, patchBooking, validate } from "@/server/services/bookings";
import { deleteBerth, patchBerth } from "@/server/services/berths";
import { createVessel, deleteVessel, patchVessel } from "@/server/services/vessels";
import { createProject, getProject, listProjects, deleteProject, MAX_USER_PROJECTS } from "@/server/services/projects";
import { availability } from "@/server/services/availability";
import { runAudit } from "@/server/services/audit";
import { getSettings, putSettings } from "@/server/services/settings";

let F: Awaited<ReturnType<typeof makeProject>>;
beforeAll(async () => { await freshDb(); }, 60_000);
beforeEach(async () => {
  await getDb().query("TRUNCATE project CASCADE");
  F = await makeProject();
});

const vesselAt = (berthId: string, vesselId: string, s: string, e: string) =>
  ({ berthId, occupantType: "vessel" as const, vesselId, startDate: s, endDate: e });

async function fails(p: Promise<unknown>): Promise<ApiErr> {
  try { await p; } catch (e) { return toApiErr(e); }
  throw new Error("expected a failure");
}

describe("bookings", () => {
  it("creates, then refuses an overlap with 409 naming the blocker", async () => {
    const a = await createBooking(F.pid, vesselAt(F.NPW, F.BIG, "2027-03-05", "2027-03-09"));
    expect(a).toMatchObject({ title: "R/V High Drift", berthName: "North Pier West", version: 1, source: "manual" });
    const e = await fails(createBooking(F.pid, vesselAt(F.NPW, F.SMALL, "2027-03-09", "2027-03-12")));
    expect(e.status).toBe(409);
    expect(e.code).toBe("CONFLICT");
    expect(e.violations?.[0]).toMatchObject({ code: "OVERLAP", bookingIds: [a.id] });
  });

  it("vessel too long → 422 with details", async () => {
    const e = await fails(createBooking(F.pid, vesselAt(F.SFE, F.BIG, "2027-03-05", "2027-03-09")));
    expect(e.status).toBe(422);
    expect(e.violations?.[0].details).toEqual({ vesselLengthFt: 120, berthLengthFt: 90, shortByFt: 30 });
  });

  it("validate is a dry run: returns violations, writes nothing", async () => {
    const r = await validate(F.pid, vesselAt(F.SFE, F.BIG, "2027-03-05", "2027-03-09"));
    expect(r.ok).toBe(false);
    expect(await listBookings(F.pid, { from: "2027-01-01", to: "2027-12-31" })).toHaveLength(0);
  });

  it("PATCH with an old expectedVersion → STALE_VERSION; the current one succeeds and bumps version", async () => {
    const a = await createBooking(F.pid, vesselAt(F.NPW, F.BIG, "2027-03-05", "2027-03-09"));
    const b = await patchBooking(F.pid, a.id, { expectedVersion: 1, endDate: "2027-03-10" });
    expect(b).toMatchObject({ endDate: "2027-03-10", version: 2 });
    const e = await fails(patchBooking(F.pid, a.id, { expectedVersion: 1, endDate: "2027-03-11" }));
    expect(e.code).toBe("STALE_VERSION");
  });

  it("an edit doesn't conflict with itself; moving onto another booking does", async () => {
    const a = await createBooking(F.pid, vesselAt(F.NPW, F.BIG, "2027-03-05", "2027-03-09"));
    await createBooking(F.pid, { berthId: F.NPW, occupantType: "event", title: "Sail day", startDate: "2027-03-20", endDate: "2027-03-20" });
    expect((await patchBooking(F.pid, a.id, { expectedVersion: 1, startDate: "2027-03-04" })).startDate).toBe("2027-03-04");
    const e = await fails(patchBooking(F.pid, a.id, { expectedVersion: 2, endDate: "2027-03-20" }));
    expect(e.violations?.[0].code).toBe("OVERLAP");
  });

  it("cancel frees the berth; booking the same days then works", async () => {
    const a = await createBooking(F.pid, vesselAt(F.NPW, F.BIG, "2027-03-05", "2027-03-09"));
    const c = await cancelBooking(F.pid, a.id, 1);
    expect(c).toMatchObject({ status: "cancelled", version: 2 });
    await createBooking(F.pid, vesselAt(F.NPW, F.SMALL, "2027-03-05", "2027-03-09"));
    expect(await listBookings(F.pid, { from: "2027-03-01", to: "2027-03-31", includeCancelled: true })).toHaveLength(2);
    expect(await listBookings(F.pid, { from: "2027-03-01", to: "2027-03-31", vesselId: F.SMALL })).toHaveLength(1);
  });

  it("schedule returns every berth and bookings touching the window, unclipped", async () => {
    await createBooking(F.pid, vesselAt(F.NPW, F.BIG, "2027-02-25", "2027-03-02"));
    const s = await getSchedule(F.pid, "2027-03-01", "2027-03-31");
    expect(s.berths.map((b) => b.name)).toEqual(["North Pier West", "South Float East", "Small Craft Slips"]);
    expect(s.bookings[0]).toMatchObject({ startDate: "2027-02-25", endDate: "2027-03-02" });
  });

  it("a berth from another project is unknown here (404)", async () => {
    const other = await makeProject({ name: "Other" });
    const e = await fails(createBooking(F.pid, vesselAt(other.NPW, F.BIG, "2027-03-05", "2027-03-09")));
    expect(e.status).toBe(404);
  });

  it("R6: can't shrink a berth under a booked vessel, or grow a vessel past its berth", async () => {
    await createBooking(F.pid, vesselAt(F.SFE, F.SMALL, "2027-03-05", "2027-03-09"));
    expect((await fails(patchBerth(F.pid, F.SFE, { lengthFt: 50 }))).violations?.[0].code).toBe("VESSEL_TOO_LONG");
    expect((await fails(patchVessel(F.pid, F.SMALL, { lengthFt: 95 }))).status).toBe(409);
    expect((await patchVessel(F.pid, F.SMALL, { lengthFt: 90 })).lengthFt).toBe(90);
  });

  it("delete refuses a berth/vessel referenced by any booking (even cancelled)", async () => {
    const a = await createBooking(F.pid, vesselAt(F.SFE, F.SMALL, "2027-03-05", "2027-03-09"));
    await cancelBooking(F.pid, a.id, 1);
    expect((await fails(deleteBerth(F.pid, F.SFE))).status).toBe(409);
    expect((await fails(deleteVessel(F.pid, F.SMALL))).status).toBe(409);
    await deleteVessel(F.pid, F.UNK);
  });

  it("names are unique per project, ignoring case; normalised on the way in", async () => {
    const v = await createVessel(F.pid, { name: "  OS/V   Sea  Dog ", lengthFt: 40 });
    expect(v.name).toBe("OSV Sea Dog");
    expect((await fails(createVessel(F.pid, { name: "osv sea dog", lengthFt: 41 }))).status).toBe(409);
  });

  it("horizon and past warnings follow the project's today", async () => {
    await putSettings(F.pid, { asOfDate: "2020-01-01" });
    expect(await getSettings(F.pid)).toEqual({ asOfDate: "2020-01-01", asOfSource: "override" });
    const r = await validate(F.pid, vesselAt(F.NPW, F.BIG, "2027-03-05", "2027-03-09"));
    expect(r.violations.map((v) => v.code)).toEqual(["BEYOND_HORIZON"]);
    await putSettings(F.pid, { asOfDate: null });
    expect((await getSettings(F.pid)).asOfSource).toBe("system");
  });
});

describe("availability and audit", () => {
  it("ranks free-and-fits first, tightest fit first", async () => {
    await createBooking(F.pid, { berthId: F.SFE, occupantType: "closure", title: "Crane", startDate: "2027-03-06", endDate: "2027-03-06" });
    const r = await availability(F.pid, { startDate: "2027-03-05", endDate: "2027-03-09", lengthFt: 50 });
    expect(r.options.map((o) => [o.berth.name, o.free, o.fits, o.slackFt])).toEqual([
      ["North Pier West", true, true, 360],
      ["Small Craft Slips", true, true, null],
      ["South Float East", false, true, 40],
    ]);
    expect(r.options[2].conflicts[0].title).toBe("Crane");
  });

  it("vessel with no length → 422 unless a length is given", async () => {
    expect((await fails(availability(F.pid, { startDate: "2027-03-05", endDate: "2027-03-09", vesselId: F.UNK }))).status).toBe(422);
  });

  it("a healthy project audits clean; a hand-made overlap is found", async () => {
    await createBooking(F.pid, vesselAt(F.NPW, F.BIG, "2027-03-05", "2027-03-20"));
    await createBooking(F.pid, vesselAt(F.SFE, F.SMALL, "2027-03-05", "2027-03-09"));
    expect((await runAudit(F.pid)).violations).toEqual([]);
    // bypass the constraint to plant a bad row, as someone editing the DB by hand might
    await getDb().exec("ALTER TABLE booking DROP CONSTRAINT booking_no_overlap");
    await getDb().query(
      `INSERT INTO booking (project_id, berth_id, berth_kind, occupant_type, title, start_date, end_date, source)
       VALUES ($1, $2, 'berth', 'event', 'Sneaky', '2027-03-10', '2027-03-11', 'manual')`, [F.pid, F.NPW]);
    const rep = await runAudit(F.pid);
    expect(rep.summary).toEqual({ OVERLAP: 1 });
    await getDb().query("DELETE FROM booking WHERE title = 'Sneaky'");
    await getDb().exec(`ALTER TABLE booking ADD CONSTRAINT booking_no_overlap EXCLUDE USING gist (berth_id WITH =, period WITH &&)
      WHERE (status = 'confirmed' AND berth_kind = 'berth')`);
  });
});

describe("projects", () => {
  async function makeTemplates() {
    const db = getDb();
    const d = await makeProject({ name: "Default fleet", template: "defaults", asOf: null });
    const s = await makeProject({ name: "Sample", template: "sample", asOf: "2019-07-01" });
    await db.query(
      `INSERT INTO booking (project_id, berth_id, berth_kind, occupant_type, vessel_id, start_date, end_date, source)
       VALUES ($1, $2, 'berth', 'vessel', $3, '2019-07-02', '2019-07-05', 'import')`, [s.pid, s.NPW, s.BIG]);
    return { d, s };
  }

  it("opening the sample clones it: equal counts, no rows pointing back, today kept", async () => {
    const { s } = await makeTemplates();
    const p = await createProject({ name: "Mine", start: "sample" });
    expect(p.counts).toEqual({ berths: 3, vessels: 3, bookings: 1 });
    expect(p.origin).toBe("sample");
    expect((await getSettings(p.id)).asOfDate).toBe("2019-07-01");
    const { rows } = await getDb().query(
      "SELECT count(*)::int AS n FROM booking k JOIN berth b ON b.id = k.berth_id WHERE k.project_id = $1 AND b.project_id = $2", [p.id, s.pid]);
    expect(rows[0]).toEqual({ n: 0 });
  });

  it("defaults clone takes the planning anchor; empty starts empty", async () => {
    await makeTemplates();
    const d = await createProject({ name: "Fleet", start: "defaults", asOfDate: "2008-04-27" });
    expect((await getSettings(d.id)).asOfDate).toBe("2008-04-27");
    const e = await createProject({ name: "Blank", start: "empty" });
    expect(e.counts).toEqual({ berths: 0, vessels: 0, bookings: 0 });
  });

  it("templates are read-only (403) and never listed", async () => {
    const { s } = await makeTemplates();
    const e = await fails(createBooking(s.pid, vesselAt(s.NPW, s.SMALL, "2019-08-01", "2019-08-02")));
    expect(e.status).toBe(403);
    expect(await listProjects([s.pid, F.pid])).toHaveLength(1);
  });

  it("get bumps lastOpenedAt; delete removes everything", async () => {
    const before = (await getProject(F.pid)).lastOpenedAt;
    await new Promise((r) => setTimeout(r, 5));
    expect((await getProject(F.pid)).lastOpenedAt >= before).toBe(true);
    await createBooking(F.pid, vesselAt(F.NPW, F.BIG, "2027-03-05", "2027-03-09"));
    await deleteProject(F.pid);
    expect((await getDb().query("SELECT count(*)::int AS n FROM booking")).rows[0]).toEqual({ n: 0 });
  });

  it("at the cap, a new project → 503", async () => {
    await getDb().query(
      "INSERT INTO project (name, origin) SELECT 'p' || g, 'empty' FROM generate_series(1, $1) g", [MAX_USER_PROJECTS]);
    expect((await fails(createProject({ name: "One too many", start: "empty" }))).status).toBe(503);
  });
});
