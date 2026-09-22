/** Small fixtures: a project with a known fleet, and ids handy for assertions. */
import { getDb } from "@/server/db/pool";

export async function makeProject(opts: { name?: string; asOf?: string | null; template?: string | null } = {}) {
  const db = getDb();
  const { rows: [p] } = await db.query<{ id: string }>(
    "INSERT INTO project (name, origin, as_of_date, template_key) VALUES ($1, $2, $3, $4) RETURNING id",
    [opts.name ?? "Test", opts.template ?? "empty", opts.asOf === undefined ? "2027-01-01" : opts.asOf, opts.template ?? null]);
  const berth = async (name: string, length: number | null, order: number) =>
    (await db.query<{ id: string }>(
      "INSERT INTO berth (project_id, name, length_ft, sort_order) VALUES ($1, $2, $3, $4) RETURNING id",
      [p.id, name, length, order])).rows[0].id;
  const vessel = async (name: string, length: number | null) =>
    (await db.query<{ id: string }>(
      "INSERT INTO vessel (project_id, name, length_ft) VALUES ($1, $2, $3) RETURNING id", [p.id, name, length])).rows[0].id;
  return {
    pid: p.id,
    NPW: await berth("North Pier West", 410, 1),
    SFE: await berth("South Float East", 90, 2),
    SLIPS: await berth("Small Craft Slips", null, 3),   // length not on record
    BIG: await vessel("R/V High Drift", 120),
    SMALL: await vessel("S/V Small", 60),
    UNK: await vessel("M/V Unknown", null),
  };
}
