/**
 * npm run db:migrate — apply db/migrations/*.sql in order, each in its own transaction, recording it in
 * schema_migration. Runs from a laptop/CI against the UNPOOLED Neon URL, never at request time (database.md §9).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Db } from "../src/server/db/types";

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(db: Db, dir = MIGRATIONS_DIR, log: (s: string) => void = () => {}): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migration")).rows.map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    await db.exec(`BEGIN;\n${sql}\n;INSERT INTO schema_migration (name) VALUES ('${f.replace(/'/g, "''")}');\nCOMMIT;`)
      .catch(async (e) => { await db.exec("ROLLBACK").catch(() => {}); throw new Error(`${f}: ${(e as Error).message}`); });
    applied.push(f);
    log(`applied ${f}`);
  }
  return applied;
}

async function main() {
  const { pgDb } = await import("../src/server/db/pool");
  const db = pgDb(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL, 1);
  const applied = await migrate(db, MIGRATIONS_DIR, console.log);
  console.log(applied.length ? `${applied.length} migration(s) applied.` : "Up to date.");
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
