// Schema tests: every DB-level rule, both sides of each edge. Runs Postgres in-process (PGlite, WASM) — no server needed.
//   npm i -D @electric-sql/pglite && node db/schema.test.mjs
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import fs from "node:fs";
const db = new PGlite({ extensions: { btree_gist } });
await db.exec(fs.readFileSync(new URL("./migrations/0001_init.sql", import.meta.url), "utf8"));
let pass = 0, fail = 0;
const one = async (q, p = []) => (await db.query(q, p)).rows[0];
async function ok(name, q, p) { try { await db.query(q, p); pass++; } catch (e) { fail++; console.log("FAIL (expected ok):", name, e.message); } }
async function bad(name, want, q, p) {
  try { await db.query(q, p); fail++; console.log("FAIL (expected error):", name); }
  catch (e) { const got = e.constraint || e.code; if (got === want) pass++; else { fail++; console.log("FAIL wrong error:", name, "want", want, "got", got, e.message); } }
}
const P = (await one(`INSERT INTO project (name, origin) VALUES ('A','empty') RETURNING id`)).id;
const Q = (await one(`INSERT INTO project (name, origin) VALUES ('B','empty') RETURNING id`)).id;
const berth = async (p, name, kind, len, o) => (await one(`INSERT INTO berth (project_id,name,kind,length_ft,sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [p, name, kind, len, o])).id;
const vessel = async (p, name, len) => (await one(`INSERT INTO vessel (project_id,name,length_ft) VALUES ($1,$2,$3) RETURNING id`, [p, name, len])).id;
const NPW = await berth(P, "North Pier West", "berth", 410, 1);
const SFE = await berth(P, "South Float East", "berth", 90, 2);
const SEC = await berth(P, "Small Craft Slips", "section", null, 3);
const NPE = await berth(P, "North Pier East", "berth", 240, 4);
const QB = await berth(Q, "Other", "berth", 100, 1);
const V120 = await vessel(P, "R/V High Drift", 120);
const V60 = await vessel(P, "S/V Small", 60);
const VUNK = await vessel(P, "M/V Unknown", null);
const ins = `INSERT INTO booking (project_id,berth_id,berth_kind,occupant_type,vessel_id,title,start_date,end_date,source,status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',COALESCE($9,'confirmed')) RETURNING id`;
const ev = (b, kind, s, e, st = null, p = P) => [p, b, kind, "event", null, "Sail day", s, e, st];
const vs = (b, kind, v, s, e, p = P) => [p, b, kind, "vessel", v, null, s, e, null];

await ok("base booking 3-9", ins, ev(NPW, "berth", "2031-03-03", "2031-03-09"));
await ok("adjacent 10-12", ins, ev(NPW, "berth", "2031-03-10", "2031-03-12"));
await bad("shared last day", "booking_no_overlap", ins, ev(NPW, "berth", "2031-03-12", "2031-03-14"));
await bad("contained", "booking_no_overlap", ins, ev(NPW, "berth", "2031-03-05", "2031-03-06"));
await bad("identical", "booking_no_overlap", ins, ev(NPW, "berth", "2031-03-03", "2031-03-09"));
await bad("containing", "booking_no_overlap", ins, ev(NPW, "berth", "2031-03-01", "2031-03-20"));
await ok("cancelled may overlap", ins, ev(NPW, "berth", "2031-03-05", "2031-03-06", "cancelled"));
await ok("section overlap 1", ins, ev(SEC, "section", "2031-03-03", "2031-03-09"));
await ok("section overlap 2", ins, ev(SEC, "section", "2031-03-03", "2031-03-09"));
await bad("lying about kind", "booking_berth_fk", ins, ev(NPW, "section", "2031-05-01", "2031-05-02"));
await bad("cross-project berth", "booking_berth_fk", ins, ev(QB, "berth", "2031-05-01", "2031-05-02"));
await bad("end before start", "booking_range_valid", ins, ev(NPW, "berth", "2031-06-09", "2031-06-01"));
await bad("invalid date", "22008", ins, ev(NPW, "berth", "2031-02-30", "2031-03-01"));
await bad("event without title", "booking_title_iff", ins, [P, NPW, "berth", "event", null, null, "2031-07-01", "2031-07-01", null]);
await bad("vessel without vessel_id", "booking_vessel_iff", ins, [P, NPW, "berth", "vessel", null, "x", "2031-07-01", "2031-07-01", null]);

await ok("vessel fits 410", ins, vs(NPW, "berth", V120, "2031-04-01", "2031-04-05"));
await bad("vessel too long 120>90", "booking_fit", ins, vs(SFE, "berth", V120, "2031-08-01", "2031-08-02"));
await ok("unknown length passes DB", ins, vs(SFE, "berth", VUNK, "2031-08-01", "2031-08-02"));
await bad("vessel two places (berth)", "booking_vessel_once", ins, vs(NPE, "berth", V120, "2031-04-05", "2031-04-06"));
await bad("vessel two places (section)", "booking_vessel_once", ins, vs(SEC, "section", V120, "2031-04-03", "2031-04-03"));
await ok("vessel next day elsewhere", ins, vs(SEC, "section", V120, "2031-04-06", "2031-04-06"));
const small = (await one(ins, vs(SFE, "berth", V60, "2031-09-01", "2031-09-03"))).id; pass++;
await bad("move into overlap (update)", "booking_no_overlap", `UPDATE booking SET berth_id=$1, start_date='2031-03-08', end_date='2031-03-08' WHERE id=$2`, [NPW, small]);
await bad("grow vessel past berth (R6)", "vessel_length_guard", `UPDATE vessel SET length_ft=95 WHERE id=$1`, [V60]);
await ok("grow vessel within berth", `UPDATE vessel SET length_ft=90 WHERE id=$1`, [V60]);
await bad("shrink berth under vessel (R6)", "berth_length_guard", `UPDATE berth SET length_ft=80 WHERE id=$1`, [SFE]);
await bad("change kind with bookings", "booking_berth_fk", `UPDATE berth SET kind='section', length_ft=NULL WHERE id=$1`, [NPW]);
await bad("delete referenced berth", "booking_berth_fk", `DELETE FROM berth WHERE id=$1`, [NPW]);
await bad("delete referenced vessel", "booking_vessel_fk", `DELETE FROM vessel WHERE id=$1`, [V120]);
await bad("dup name case-insensitive", "vessel_name_uq", `INSERT INTO vessel (project_id,name,length_ft) VALUES ($1,'r/v high drift',10)`, [P]);
await ok("same name other project", `INSERT INTO vessel (project_id,name,length_ft) VALUES ($1,'R/V High Drift',10)`, [Q]);

const before = await one(`SELECT (SELECT count(*) FROM berth WHERE project_id=$1) b, (SELECT count(*) FROM vessel WHERE project_id=$1) v, (SELECT count(*) FROM booking WHERE project_id=$1) k`, [P]);
const C = (await one(`SELECT clone_project($1,'Copy','sample') AS id`, [P])).id;
const after = await one(`SELECT (SELECT count(*) FROM berth WHERE project_id=$1) b, (SELECT count(*) FROM vessel WHERE project_id=$1) v, (SELECT count(*) FROM booking WHERE project_id=$1) k`, [C]);
if (JSON.stringify(before) === JSON.stringify(after)) pass++; else { fail++; console.log("FAIL clone counts", before, after); }
const shared = await one(`SELECT count(*) n FROM booking c JOIN berth b ON b.id=c.berth_id WHERE c.project_id=$1 AND b.project_id<>$1`, [C]);
if (+shared.n === 0) pass++; else { fail++; console.log("FAIL clone points at source berths"); }
await ok("clone twice in one session", `SELECT clone_project($1,'Copy2','sample')`, [P]);
await ok("delete project cascades", `DELETE FROM project WHERE id=$1`, [P]);
const left = await one(`SELECT count(*) n FROM booking WHERE project_id=$1`, [P]);
if (+left.n === 0) pass++; else { fail++; console.log("FAIL cascade left rows"); }
// Postgres stores [a,b] as [a,b+1): upper(period) is the day AFTER end_date
const r = await one(`SELECT period::text p, upper(period)::text u FROM booking WHERE project_id=$1 LIMIT 1`, [C]);
console.log("range canonical form:", r);
console.log(`\n${pass} passed, ${fail} failed`);
