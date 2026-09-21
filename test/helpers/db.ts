/** A fresh in-process Postgres (PGlite) per test file, migrated with the real migrations, installed as the app's Db. */
import { PGlite, types } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import type { Db, Queryable, QueryResult } from "@/server/db/types";
import { setDb } from "@/server/db/pool";
import { migrate } from "../../db/migrate";

const parsers = {
  [types.DATE]: (v: string) => v,             // same as production: dates stay strings
  [types.NUMERIC]: (v: string) => parseFloat(v),
};

function wrap(pg: Pick<PGlite, "query">): Queryable {
  return {
    async query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
      const r = await pg.query<T>(text, params as unknown[], { parsers });
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  };
}

export async function freshDb(): Promise<{ db: Db; pg: PGlite }> {
  const pg = new PGlite({ extensions: { btree_gist } });
  const db: Db = {
    ...wrap(pg),
    tx: (fn) => pg.transaction((t) => fn(wrap(t))),
    exec: async (sql) => { await pg.exec(sql); },
  };
  await migrate(db);
  setDb(db);
  return { db, pg };
}
