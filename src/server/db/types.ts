/**
 * The one database seam. Services talk to `Db`; production backs it with node-postgres (pool.ts),
 * tests with PGlite (test/helpers/db.ts). Keep it this small: parameterised queries + transactions.
 */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  /** BEGIN … COMMIT around fn; ROLLBACK and rethrow if fn throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** Run a multi-statement SQL script (migrations). No parameters. */
  exec(sql: string): Promise<void>;
}
