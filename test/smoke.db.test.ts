import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { freshDb } from "./helpers/db";
import { MIGRATIONS_DIR } from "../db/migrate";
describe("migrations", () => {
  it("apply cleanly on PGlite, all of them, in order", async () => {
    const { db } = await freshDb();
    const { rows } = await db.query<{ name: string }>("SELECT name FROM schema_migration ORDER BY name");
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    expect(rows.map((r) => r.name)).toEqual(files);
  }, 60_000);
});
