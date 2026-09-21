/** OP-03: which berths are free and long enough, tightest fit first (backend.md §5 Availability). */
import type { AvailabilityOption, AvailabilityResult, ISODate } from "@shared/contract";
import { getDb } from "../db/pool";
import { ApiErr, badRequest, notFound } from "../http/api-error";
import { isISODate } from "../domain/dates";
import { toBerth } from "./mappers";
import { requireProject } from "./projects";

export async function availability(
  pid: string, q: { startDate: ISODate; endDate: ISODate; vesselId?: string; lengthFt?: number },
): Promise<AvailabilityResult> {
  const db = getDb();
  await requireProject(db, pid);
  if (!isISODate(q.startDate) || !isISODate(q.endDate) || q.endDate < q.startDate) {
    throw badRequest("startDate/endDate must be real dates with endDate ≥ startDate.");
  }

  let lengthFt: number | null = q.lengthFt ?? null;
  if (q.vesselId) {
    const { rows } = await db.query<{ name: string; length_ft: number | null }>(
      "SELECT name, length_ft FROM vessel WHERE id = $1 AND project_id = $2", [q.vesselId, pid]);
    if (!rows[0]) throw notFound("Vessel");
    if (rows[0].length_ft == null && lengthFt == null) {
      throw new ApiErr("UNPROCESSABLE", `${rows[0].name} has no length on record. Give a length in feet instead.`);
    }
    lengthFt = rows[0].length_ft ?? lengthFt;
  }

  const [berths, clashes] = await Promise.all([
    db.query("SELECT * FROM berth WHERE project_id = $1 AND active ORDER BY sort_order, lower(name)", [pid]),
    db.query<{ id: string; berth_id: string; display_title: string; start_date: string; end_date: string }>(
      `SELECT id, berth_id, display_title, start_date, end_date FROM booking_view
       WHERE project_id = $1 AND status = 'confirmed' AND berth_kind = 'berth'
         AND period && daterange($2::date, $3::date, '[]') ORDER BY start_date`, [pid, q.startDate, q.endDate]),
  ]);

  const options: AvailabilityOption[] = berths.rows.map(toBerth).map((berth) => {
    const conflicts = berth.kind === "section" ? [] : clashes.rows
      .filter((c) => c.berth_id === berth.id)
      .map((c) => ({ bookingId: c.id, title: c.display_title, startDate: c.start_date, endDate: c.end_date }));
    const fits = lengthFt == null || berth.kind === "section" || (berth.lengthFt != null && berth.lengthFt >= lengthFt);
    const slackFt = lengthFt == null || berth.lengthFt == null ? null : Math.round((berth.lengthFt - lengthFt) * 10) / 10;
    return { berth, free: conflicts.length === 0, fits, slackFt, conflicts };
  });

  options.sort((a, b) => {
    const good = (o: AvailabilityOption) => (o.free && o.fits ? 0 : 1);
    if (good(a) !== good(b)) return good(a) - good(b);
    if (a.slackFt !== b.slackFt) {
      if (a.slackFt == null) return 1;
      if (b.slackFt == null) return -1;
      return a.slackFt - b.slackFt;
    }
    return a.berth.sortOrder - b.berth.sortOrder;
  });

  return { startDate: q.startDate, endDate: q.endDate, lengthFt, options };
}
