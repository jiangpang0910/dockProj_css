/** Tours (the workbook's Tours tab) and the berth-usage summary. Tours hold no berth, so no rule applies to them. */
import type { BerthUsage, Tour, TourInput } from "@shared/contract";
import type { Queryable } from "../db/types";
import { getDb } from "../db/pool";
import { notFound } from "../http/api-error";
import { requireProject } from "./projects";

const SELECT = `SELECT t.id, t.date, t.time, t.guide, t.guest, t.people, t.vessel_name, t.notes,
                  (SELECT v.id FROM vessel v WHERE v.project_id = t.project_id AND lower(v.name) = lower(t.vessel_name) LIMIT 1) AS vessel_id
                FROM tour t`;

interface TourRow { id: string; date: string; time: string | null; guide: string | null; guest: string | null; people: number | null; vessel_name: string | null; notes: string | null; vessel_id: string | null }
const toTour = (r: TourRow): Tour => ({ id: r.id, date: r.date, time: r.time, guide: r.guide, guest: r.guest, people: r.people, vesselName: r.vessel_name, vesselId: r.vessel_id, notes: r.notes });

export async function listTours(pid: string, f: { from?: string; to?: string; q?: string } = {}): Promise<Tour[]> {
  const q = getDb();
  await requireProject(q, pid);
  const params: unknown[] = [pid];
  let where = "t.project_id = $1";
  if (f.from) { params.push(f.from); where += ` AND t.date >= $${params.length}`; }
  if (f.to) { params.push(f.to); where += ` AND t.date <= $${params.length}`; }
  if (f.q?.trim()) {
    params.push(`%${f.q.trim().replace(/[\\%_]/g, (c) => "\\" + c)}%`);
    where += ` AND (t.guide ILIKE $${params.length} OR t.guest ILIKE $${params.length} OR t.vessel_name ILIKE $${params.length} OR t.notes ILIKE $${params.length})`;
  }
  const { rows } = await q.query<TourRow>(`${SELECT} WHERE ${where} ORDER BY t.date, t.time NULLS LAST, t.guide`, params);
  return rows.map(toTour);
}

export async function createTour(pid: string, input: TourInput): Promise<Tour> {
  const q = getDb();
  await requireProject(q, pid, { write: true });
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO tour (project_id, date, time, guide, guest, people, vessel_name, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [pid, input.date, input.time ?? null, input.guide ?? null, input.guest ?? null, input.people ?? null, input.vesselName ?? null, input.notes ?? null]);
  return loadTour(q, pid, rows[0].id);
}

export async function patchTour(pid: string, id: string, patch: Partial<TourInput>): Promise<Tour> {
  const q = getDb();
  await requireProject(q, pid, { write: true });
  const has = (k: keyof TourInput) => Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined;
  const r = await q.query(
    `UPDATE tour SET
       date = COALESCE($3, date),
       time = CASE WHEN $4::boolean THEN $5 ELSE time END,
       guide = CASE WHEN $6::boolean THEN $7 ELSE guide END,
       guest = CASE WHEN $8::boolean THEN $9 ELSE guest END,
       people = CASE WHEN $10::boolean THEN $11::int ELSE people END,
       vessel_name = CASE WHEN $12::boolean THEN $13 ELSE vessel_name END,
       notes = CASE WHEN $14::boolean THEN $15 ELSE notes END,
       updated_at = now()
     WHERE id = $1 AND project_id = $2`,
    [id, pid, patch.date ?? null, has("time"), patch.time ?? null, has("guide"), patch.guide ?? null, has("guest"), patch.guest ?? null,
      has("people"), patch.people ?? null, has("vesselName"), patch.vesselName ?? null, has("notes"), patch.notes ?? null]);
  if (!r.rowCount) throw notFound("Tour");
  return loadTour(q, pid, id);
}

export async function deleteTour(pid: string, id: string): Promise<void> {
  const q = getDb();
  await requireProject(q, pid, { write: true });
  const r = await q.query("DELETE FROM tour WHERE id = $1 AND project_id = $2", [id, pid]);
  if (!r.rowCount) throw notFound("Tour");
}

async function loadTour(q: Queryable, pid: string, id: string): Promise<Tour> {
  const { rows } = await q.query<TourRow>(`${SELECT} WHERE t.id = $1 AND t.project_id = $2`, [id, pid]);
  if (!rows[0]) throw notFound("Tour");
  return toTour(rows[0]);
}

/** The workbook's own usage figures, oldest year first, berths in schedule order (names without a berth row last). */
export async function berthUsage(pid: string): Promise<BerthUsage[]> {
  const q = getDb();
  await requireProject(q, pid);
  const { rows } = await q.query<{ berth_name: string; berth_id: string | null; year: number; days: number }>(
    `SELECT u.berth_name, b.id AS berth_id, u.year, u.days
     FROM berth_usage u LEFT JOIN berth b ON b.project_id = u.project_id AND lower(b.name) = lower(u.berth_name)
     WHERE u.project_id = $1 ORDER BY b.sort_order NULLS LAST, u.berth_name, u.year`, [pid]);
  return rows.map((r) => ({ berthName: r.berth_name, berthId: r.berth_id, year: r.year, days: r.days }));
}
