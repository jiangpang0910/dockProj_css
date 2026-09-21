/** Projects: the workspace every other resource lives in (infrastructure.md §2, §5). */
import type { ISODate, Project, ProjectInput } from "@shared/contract";
import type { Queryable } from "../db/types";
import { getDb } from "../db/pool";
import { ApiErr, notFound } from "../http/api-error";
import { todayIn } from "../domain/dates";
import { isoTime } from "./mappers";

export const MAX_USER_PROJECTS = 300;
export const FACILITY_TZ = "America/New_York";

export interface ProjectRow {
  id: string;
  name: string;
  origin: Project["origin"];
  template_key: string | null;
  as_of_date: ISODate | null;
  created_at: unknown;
  last_opened_at: unknown;
}

/** Load a project or 404. `write: true` → 403 on a read-only template. */
export async function requireProject(q: Queryable, pid: string, opts: { write?: boolean } = {}): Promise<ProjectRow> {
  const { rows } = await q.query<ProjectRow>("SELECT * FROM project WHERE id = $1", [pid]);
  const p = rows[0];
  if (!p) throw notFound("Project");
  if (opts.write && p.template_key) throw new ApiErr("FORBIDDEN", "This is a read-only template project.");
  return p;
}

/** The project's "today": its override, or the real date in the facility's zone (Vercel runs in UTC). */
export function asOfDate(p: Pick<ProjectRow, "as_of_date">): ISODate {
  return p.as_of_date ?? todayIn(FACILITY_TZ);
}

const PROJECT_SELECT = `
  SELECT p.*,
    (SELECT count(*) FROM berth b WHERE b.project_id = p.id)::int AS n_berths,
    (SELECT count(*) FROM vessel v WHERE v.project_id = p.id)::int AS n_vessels,
    (SELECT count(*) FROM booking k WHERE k.project_id = p.id AND k.status = 'confirmed')::int AS n_bookings
  FROM project p`;

function toProject(r: Record<string, unknown>): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    origin: r.origin as Project["origin"],
    createdAt: isoTime(r.created_at),
    lastOpenedAt: isoTime(r.last_opened_at),
    counts: { berths: r.n_berths as number, vessels: r.n_vessels as number, bookings: r.n_bookings as number },
  };
}

async function loadProject(q: Queryable, pid: string): Promise<Project> {
  const { rows } = await q.query(`${PROJECT_SELECT} WHERE p.id = $1`, [pid]);
  if (!rows[0]) throw notFound("Project");
  return toProject(rows[0]);
}

/** Only the ids asked for (the ones this browser remembers). Never lists all; never returns templates. */
export async function listProjects(ids: string[]): Promise<Project[]> {
  if (!ids.length) return [];
  const { rows } = await getDb().query(
    `${PROJECT_SELECT} WHERE p.id = ANY($1::uuid[]) AND p.template_key IS NULL ORDER BY p.last_opened_at DESC`, [ids]);
  return rows.map(toProject);
}

export async function createProject(input: ProjectInput): Promise<Project> {
  const db = getDb();
  return db.tx(async (q) => {
    const { rows: [{ n }] } = await q.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM project WHERE template_key IS NULL");
    if (n >= MAX_USER_PROJECTS) throw new ApiErr("UNAVAILABLE", "The demo is full right now — try again tomorrow.");

    let id: string;
    if (input.start === "empty") {
      const r = await q.query<{ id: string }>(
        "INSERT INTO project (name, origin, as_of_date) VALUES ($1, 'empty', $2) RETURNING id",
        [input.name, input.asOfDate ?? null]);
      id = r.rows[0].id;
    } else {
      const t = await q.query<{ id: string }>("SELECT id FROM project WHERE template_key = $1", [input.start]);
      if (!t.rows[0]) throw new ApiErr("UNAVAILABLE", `The ${input.start} template hasn't been set up yet.`);
      const r = await q.query<{ id: string }>("SELECT clone_project($1, $2, $3) AS id", [t.rows[0].id, input.name, input.start]);
      id = r.rows[0].id;
      // The sample keeps its shipped "today" (2019-07-01); the default fleet takes the planning anchor if given.
      if (input.start === "defaults" && input.asOfDate !== undefined) {
        await q.query("UPDATE project SET as_of_date = $2 WHERE id = $1", [id, input.asOfDate]);
      }
    }
    return loadProject(q, id);
  });
}

/** Opening a project bumps last_opened_at — the cleanup clock (infrastructure.md §5). */
export async function getProject(pid: string): Promise<Project> {
  const q = getDb();
  await requireProject(q, pid);
  await q.query("UPDATE project SET last_opened_at = now() WHERE id = $1 AND template_key IS NULL", [pid]);
  return loadProject(q, pid);
}

export async function renameProject(pid: string, name: string): Promise<Project> {
  const q = getDb();
  await requireProject(q, pid, { write: true });
  await q.query("UPDATE project SET name = $2 WHERE id = $1", [pid, name]);
  return loadProject(q, pid);
}

export async function deleteProject(pid: string): Promise<void> {
  const q = getDb();
  await requireProject(q, pid, { write: true });
  await q.query("DELETE FROM project WHERE id = $1", [pid]);
}

/** Daily cron: drop user projects idle for 14 days. Returns how many went. */
export async function cleanupIdleProjects(days = 14): Promise<number> {
  const r = await getDb().query(
    "DELETE FROM project WHERE template_key IS NULL AND last_opened_at < now() - make_interval(days => $1)", [days]);
  return r.rowCount;
}
