/** Berths (OP-08). R6: a length change can't break a confirmed booking — checked here first to name the bookings. */
import type { Berth, BerthInput, BerthPatch } from "@shared/contract";
import { getDb } from "../db/pool";
import { ApiErr, notFound } from "../http/api-error";
import { normalizeName, toBerth } from "./mappers";
import { requireProject } from "./projects";

export async function listBerths(pid: string, includeInactive = false): Promise<Berth[]> {
  const q = getDb();
  await requireProject(q, pid);
  const { rows } = await q.query(
    `SELECT * FROM berth WHERE project_id = $1 ${includeInactive ? "" : "AND active"} ORDER BY sort_order, lower(name)`, [pid]);
  return rows.map(toBerth);
}

async function loadBerth(pid: string, id: string): Promise<Berth> {
  const { rows } = await getDb().query("SELECT * FROM berth WHERE id = $1 AND project_id = $2", [id, pid]);
  if (!rows[0]) throw notFound("Berth");
  return toBerth(rows[0]);
}

export async function createBerth(pid: string, input: BerthInput): Promise<Berth> {
  const q = getDb();
  await requireProject(q, pid, { write: true });
  const { rows } = await q.query(
    `INSERT INTO berth (project_id, name, kind, length_ft, sort_order)
     VALUES ($1, $2, $3, $4, COALESCE($5, (SELECT COALESCE(max(sort_order), 0) + 1 FROM berth WHERE project_id = $1)))
     RETURNING *`,
    [pid, normalizeName(input.name), input.kind, input.kind === "berth" ? input.lengthFt : null, input.sortOrder ?? null]);
  return toBerth(rows[0]);
}

export async function patchBerth(pid: string, id: string, patch: BerthPatch): Promise<Berth> {
  const q = getDb();
  await requireProject(q, pid, { write: true });
  const berth = await loadBerth(pid, id);
  if (patch.lengthFt !== undefined) {
    if (berth.kind === "berth" && patch.lengthFt === null) {
      throw new ApiErr("UNPROCESSABLE", "A berth needs a length. Only shared sections have none.");
    }
    if (berth.kind === "section" && patch.lengthFt !== null) {
      throw new ApiErr("UNPROCESSABLE", "A shared section has no length. Delete it and create a berth instead.");
    }
    if (berth.kind === "berth" && patch.lengthFt != null && berth.lengthFt != null && patch.lengthFt < berth.lengthFt) {
      const { rows } = await q.query<{ id: string; name: string; length_ft: number }>(
        `SELECT b.id, v.name, v.length_ft FROM booking b JOIN vessel v ON v.id = b.vessel_id
         WHERE b.berth_id = $1 AND b.status = 'confirmed' AND v.length_ft > $2 ORDER BY b.start_date`, [id, patch.lengthFt]);
      if (rows.length) {
        const names = [...new Set(rows.map((r) => `${r.name} (${r.length_ft}′)`))].slice(0, 3).join(", ");
        const message = `${berth.name} can't shrink to ${patch.lengthFt}′: ${rows.length} confirmed booking(s) have longer vessels, e.g. ${names}.`;
        throw new ApiErr("CONFLICT", message,
          [{ code: "VESSEL_TOO_LONG", severity: "error", message, bookingIds: rows.map((r) => r.id) }]);
      }
    }
  }
  const { rows } = await q.query(
    `UPDATE berth SET
       name = COALESCE($3, name),
       length_ft = CASE WHEN $4::boolean THEN $5::numeric ELSE length_ft END,
       active = COALESCE($6, active),
       sort_order = COALESCE($7, sort_order)
     WHERE id = $1 AND project_id = $2 RETURNING *`,
    [id, pid, patch.name != null ? normalizeName(patch.name) : null, patch.lengthFt !== undefined, patch.lengthFt ?? null,
     patch.active ?? null, patch.sortOrder ?? null]);
  return toBerth(rows[0]);
}

/** Hard delete only when no booking of any status references it (history counts); else 409 → UI offers deactivate. */
export async function deleteBerth(pid: string, id: string): Promise<void> {
  const q = getDb();
  await requireProject(q, pid, { write: true });
  const berth = await loadBerth(pid, id);
  const { rows: [{ n }] } = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM booking WHERE berth_id = $1", [id]);
  if (n > 0) {
    throw new ApiErr("CONFLICT", `${berth.name} has ${n} booking(s), including cancelled ones. Deactivate it instead.`);
  }
  await q.query("DELETE FROM berth WHERE id = $1", [id]);
}
