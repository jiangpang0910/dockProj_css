// 0007 drops berth.kind. The interesting half is the data already in the wild: a "section" could hold two
// overlapping stays, and R2 now covers every berth, so the migration has to settle them before it can widen
// the constraint. This runs 0001–0006, plants that exact shape, then applies 0007 alone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PGlite, types } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { migrate, MIGRATIONS_DIR } from "../db/migrate";
import type { Db, Queryable, QueryResult } from "@/server/db/types";

const parsers = { [types.DATE]: (v: string) => v, [types.NUMERIC]: (v: string) => parseFloat(v) };
const wrap = (pg: Pick<PGlite, "query">): Queryable => ({
  async query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    const r = await pg.query<T>(text, params as unknown[], { parsers });
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  },
});

/** A migrations dir holding only the files up to `last`, so we can stop before 0007 and resume after. */
function dirUpTo(last: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  for (const f of fs.readdirSync(MIGRATIONS_DIR).sort()) {
    if (f <= last) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  }
  return dir;
}

describe("0007 drop berth kind", () => {
  it("cancels the shorter of two stays that shared a section, and keeps the longer", { timeout: 60_000 }, async () => {
    const pg = new PGlite({ extensions: { btree_gist } });
    const db: Db = { ...wrap(pg), tx: (fn) => pg.transaction((t) => fn(wrap(t))), exec: async (s) => { await pg.exec(s); } };

    await migrate(db, dirUpTo("0006_owner.sql"));
    const { rows: [p] } = await db.query<{ id: string }>(
      "INSERT INTO project (name, origin, as_of_date) VALUES ('t', 'empty', '2020-01-01') RETURNING id");
    const { rows: [sec] } = await db.query<{ id: string }>(
      `INSERT INTO berth (project_id, name, kind, length_ft, sort_order)
       VALUES ($1, 'Small Craft Slips', 'section', NULL, 1) RETURNING id`, [p.id]);
    const { rows: [berth] } = await db.query<{ id: string }>(
      `INSERT INTO berth (project_id, name, kind, length_ft, sort_order)
       VALUES ($1, 'North Pier', 'berth', 100, 2) RETURNING id`, [p.id]);
    const add = async (berthId: string, kind: string, title: string, s: string, e: string) =>
      (await db.query<{ id: string }>(
        `INSERT INTO booking (project_id, berth_id, berth_kind, occupant_type, title, start_date, end_date, source)
         VALUES ($1, $2, $3, 'event', $4, $5, $6, 'import') RETURNING id`, [p.id, berthId, kind, title, s, e])).rows[0];
    const long = await add(sec.id, "section", "ten days", "2020-03-01", "2020-03-10");
    const short = await add(sec.id, "section", "five days", "2020-03-04", "2020-03-08");
    const untouched = await add(berth.id, "berth", "on a real berth", "2020-03-01", "2020-03-02");

    await migrate(db, dirUpTo("0007_drop_berth_kind.sql"));

    const { rows } = await db.query<{ id: string; status: string; notes: string | null }>(
      "SELECT id, status, notes FROM booking ORDER BY start_date, end_date");
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(long.id)!.status).toBe("confirmed");
    expect(byId.get(short.id)!.status).toBe("cancelled");
    expect(byId.get(short.id)!.notes).toContain("[0007]");
    expect(byId.get(untouched.id)!.status).toBe("confirmed");

    // kind is gone on both tables, and R2 now guards every berth.
    const { rows: cols } = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE (table_name = 'berth' AND column_name = 'kind')
          OR (table_name = 'booking' AND column_name = 'berth_kind')
          OR (table_name = 'import_staged_berth' AND column_name = 'kind')`);
    expect(cols).toEqual([]);
    await expect(db.query(
      `INSERT INTO booking (project_id, berth_id, occupant_type, title, start_date, end_date, source)
       VALUES ($1, $2, 'event', 'overlaps the keeper', '2020-03-05', '2020-03-06', 'manual')`, [p.id, sec.id]),
    ).rejects.toThrow();
  });
});
