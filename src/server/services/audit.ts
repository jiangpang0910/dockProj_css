/**
 * OP-11: re-verify R1–R4 over every confirmed booking of a project, independently of the constraints.
 * Sort per berth / per vessel and sweep, tracking the furthest end seen so far (so a long stay that contains
 * several later ones is still caught). O(n log n). On a healthy database the result is empty.
 */
import type { AuditReport, Violation, ViolationCode } from "@shared/contract";
import { getDb } from "../db/pool";
import { formatRange, isISODate } from "../domain/dates";
import { requireProject } from "./projects";

interface Row {
  id: string; berth_id: string; berth_name: string; berth_kind: string; berth_length_ft: number | null;
  vessel_id: string | null; vessel_length_ft: number | null; display_title: string; start_date: string; end_date: string;
}

export async function runAudit(pid: string): Promise<AuditReport> {
  const db = getDb();
  await requireProject(db, pid);
  const { rows } = await db.query<Row>(
    `SELECT id, berth_id, berth_name, berth_kind, berth_length_ft, vessel_id, vessel_length_ft, display_title, start_date, end_date
     FROM booking_view WHERE project_id = $1 AND status = 'confirmed' ORDER BY start_date, end_date, id`, [pid]);

  const found = new Map<string, Violation[]>();
  const flag = (id: string, v: Violation) => found.set(id, [...(found.get(id) ?? []), v]);

  for (const r of rows) {
    if (!isISODate(r.start_date) || !isISODate(r.end_date) || r.end_date < r.start_date) {
      flag(r.id, { code: "INVALID_RANGE", severity: "error", message: `Invalid range ${r.start_date} – ${r.end_date}.` });
    }
    if (r.berth_kind === "berth" && r.vessel_length_ft != null && r.berth_length_ft != null && r.vessel_length_ft > r.berth_length_ft) {
      flag(r.id, { code: "VESSEL_TOO_LONG", severity: "error",
        message: `${r.display_title} (${r.vessel_length_ft}′) is longer than ${r.berth_name} (${r.berth_length_ft}′).`,
        details: { vesselLengthFt: r.vessel_length_ft, berthLengthFt: r.berth_length_ft,
                   shortByFt: Math.round((r.vessel_length_ft - r.berth_length_ft) * 10) / 10 } });
    }
  }

  const sweep = (groups: Map<string, Row[]>, code: ViolationCode, describe: (a: Row, b: Row) => string) => {
    for (const list of groups.values()) {
      let reach: Row | null = null; // the booking with the furthest end so far
      for (const r of list) {
        if (reach && r.start_date <= reach.end_date) {
          flag(r.id, { code, severity: "error", message: describe(r, reach), bookingIds: [reach.id] });
        }
        if (!reach || r.end_date > reach.end_date) reach = r;
      }
    }
  };
  const group = (key: (r: Row) => string | null) => {
    const m = new Map<string, Row[]>();
    for (const r of rows) { const k = key(r); if (k) m.set(k, [...(m.get(k) ?? []), r]); }
    return m;
  };
  sweep(group((r) => (r.berth_kind === "berth" ? r.berth_id : null)), "OVERLAP",
    (r, o) => `${r.berth_name} is double-booked: ${r.display_title} ${formatRange(r.start_date, r.end_date)} overlaps ${o.display_title} ${formatRange(o.start_date, o.end_date)}.`);
  sweep(group((r) => r.vessel_id), "VESSEL_DOUBLE_BERTHED",
    (r, o) => `${r.display_title} is at ${r.berth_name} and ${o.berth_name} at once (${formatRange(r.start_date, r.end_date)}).`);

  const summary: Partial<Record<ViolationCode, number>> = {};
  for (const vs of found.values()) for (const v of vs) summary[v.code] = (summary[v.code] ?? 0) + 1;
  return {
    generatedAt: new Date().toISOString(),
    checkedBookings: rows.length,
    violations: [...found].map(([bookingId, violations]) => ({ bookingId, violations })),
    summary,
  };
}
