/** Vessels (OP-07). R6: a longer length can't break a confirmed booking. */
import type { Vessel, VesselInput } from "@shared/contract";
import { getDb } from "../db/pool";
import { ApiErr, notFound } from "../http/api-error";
import { normalizeName, toVessel } from "./mappers";
import { requireProject } from "./projects";

export async function listVessels(pid: string, opts: { q?: string; lengthUnknown?: boolean } = {}): Promise<Vessel[]> {
  const db = getDb();
  await requireProject(db, pid);
  const params: unknown[] = [pid];
  let where = "project_id = $1";
  if (opts.q?.trim()) {
    params.push(`%${opts.q.trim().replace(/[\\%_]/g, (c) => "\\" + c)}%`);
    where += ` AND name ILIKE $${params.length}`;
  }
  if (opts.lengthUnknown) where += " AND length_ft IS NULL";
  const { rows } = await db.query(`SELECT * FROM vessel WHERE ${where} ORDER BY lower(name)`, params);
  return rows.map(toVessel);
}

async function loadVessel(pid: string, id: string): Promise<Vessel> {
  const { rows } = await getDb().query("SELECT * FROM vessel WHERE id = $1 AND project_id = $2", [id, pid]);
  if (!rows[0]) throw notFound("Vessel");
  return toVessel(rows[0]);
}

export async function createVessel(pid: string, input: VesselInput): Promise<Vessel> {
  const q = getDb();
  await requireProject(q, pid, { write: true });
  const { rows } = await q.query(
    `INSERT INTO vessel (project_id, name, length_ft, draft_ft, operator, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [pid, normalizeName(input.name), input.lengthFt, input.draftFt ?? null, input.operator ?? null, input.notes ?? null]);
  return toVessel(rows[0]);
}

export async function patchVessel(pid: string, id: string, patch: Partial<VesselInput>): Promise<Vessel> {
  const q = getDb();
  await requireProject(q, pid, { write: true });
  const vessel = await loadVessel(pid, id);
  if (patch.lengthFt != null && (vessel.lengthFt == null || patch.lengthFt > vessel.lengthFt)) {
    const { rows } = await q.query<{ id: string; name: string; length_ft: number }>(
      `SELECT b.id, be.name, be.length_ft FROM booking b JOIN berth be ON be.id = b.berth_id
       WHERE b.vessel_id = $1 AND b.status = 'confirmed' AND be.length_ft < $2 ORDER BY b.start_date`, [id, patch.lengthFt]);
    if (rows.length) {
      const names = [...new Set(rows.map((r) => `${r.name} (${r.length_ft}′)`))].slice(0, 3).join(", ");
      const message = `At ${patch.lengthFt}′, ${vessel.name} would be too long for ${rows.length} confirmed booking(s) on ${names}.`;
      throw new ApiErr("CONFLICT", message,
        [{ code: "VESSEL_TOO_LONG", severity: "error", message, bookingIds: rows.map((r) => r.id) }]);
    }
  }
  const has = (k: keyof VesselInput) => Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined;
  const { rows } = await q.query(
    `UPDATE vessel SET
       name = COALESCE($3, name),
       length_ft = COALESCE($4, length_ft),
       draft_ft = CASE WHEN $5::boolean THEN $6::numeric ELSE draft_ft END,
       operator = CASE WHEN $7::boolean THEN $8 ELSE operator END,
       notes = CASE WHEN $9::boolean THEN $10 ELSE notes END
     WHERE id = $1 AND project_id = $2 RETURNING *`,
    [id, pid, patch.name != null ? normalizeName(patch.name) : null, patch.lengthFt ?? null,
     has("draftFt"), patch.draftFt ?? null, has("operator"), patch.operator ?? null, has("notes"), patch.notes ?? null]);
  return toVessel(rows[0]);
}

export async function deleteVessel(pid: string, id: string): Promise<void> {
  const q = getDb();
  await requireProject(q, pid, { write: true });
  const vessel = await loadVessel(pid, id);
  const { rows: [{ n }] } = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM booking WHERE vessel_id = $1", [id]);
  if (n > 0) throw new ApiErr("CONFLICT", `${vessel.name} is used by ${n} booking(s), including cancelled ones. It can't be deleted.`);
  await q.query("DELETE FROM vessel WHERE id = $1", [id]);
}
