/**
 * Production Db: one pg.Pool per function instance (module scope), reused across warm invocations.
 * Always the Neon *pooled* URL (infrastructure.md §3). Type parsers keep dates as strings and lengths as numbers.
 */
import pg from "pg";
import type { Db, Queryable, QueryResult } from "./types";

// 1082 = date → "YYYY-MM-DD" string (never a JS Date: that shifts days by time zone)
pg.types.setTypeParser(1082, (v: string) => v);
// 1700 = numeric → number (lengths have one decimal; float is exact enough)
pg.types.setTypeParser(1700, (v: string) => parseFloat(v));

let db: Db | null = null;

/** Tests (and scripts) install their own Db; the app lazily creates the pg one. */
export function setDb(next: Db | null): void {
  db = next;
}

export function getDb(): Db {
  if (!db) db = pgDb(process.env.DATABASE_URL);
  return db;
}

function wrap(c: pg.Pool | pg.PoolClient): Queryable {
  return {
    async query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
      const r = await c.query(text, params as unknown[]);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
  };
}

export function pgDb(connectionString: string | undefined, max = 3): Db {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString, max });
  return {
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(wrap(client));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async exec(sql) {
      await pool.query(sql);
    },
  };
}
