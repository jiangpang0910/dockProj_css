import { describe, expect, it } from "vitest";
import { freshDb } from "./helpers/db";
describe("migrations", () => {
  it("apply cleanly on PGlite", async () => {
    const { db } = await freshDb();
    const { rows } = await db.query<{ name: string }>("SELECT name FROM schema_migration ORDER BY name");
    expect(rows.map((r) => r.name)).toEqual(["0001_init.sql", "0002_import_window.sql", "0003_conflicts.sql"]);
  }, 60_000);
});
