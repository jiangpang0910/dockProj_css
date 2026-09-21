/**
 * Conflicts (frontend.md §3.9): claims an import couldn't place. Listed, summarised, placed one at a time through
 * the normal booking rules, or dismissed one at a time / in bulk. Blockers are computed live, never stored.
 */
import {
  CONFLICT_TYPES, type Conflict, type ConflictBlocker, type ConflictSummary, type ConflictType, type DismissConflictsInput,
  type Page, type ResolveConflictInput,
} from "@shared/contract";
import type { Queryable } from "../db/types";
import { getDb } from "../db/pool";
import { ApiErr, notFound } from "../http/api-error";
import { insertBooking } from "./bookings";
import { isoTime } from "./mappers";
import { asOfDate, requireProject } from "./projects";

interface ConflictRowDb {
  id: string; import_id: string | null; type: string; status: string;
  occupant_type: string; title: string; berth_label: string | null; berth_name: string | null; vessel_name: string | null;
  start_date: string; end_date: string; notes: string | null; sheet: string; cell: string | null; message: string;
  berth_id: string | null; vessel_id: string | null; booking_id: string | null; live_booking_ids: string[]; resolution_note: string | null;
  created_at: unknown; resolved_at: unknown;
  live_berth_name: string | null; berth_length_ft: number | null; vessel_length_ft: number | null;
}

const SELECT = `
  SELECT c.*, be.name AS live_berth_name, be.length_ft AS berth_length_ft, v.length_ft AS vessel_length_ft,
         ARRAY(SELECT b.id FROM booking b WHERE b.id = ANY(c.booking_ids) ORDER BY b.start_date) AS live_booking_ids
  FROM conflict c
  LEFT JOIN berth be ON be.id = c.berth_id
  LEFT JOIN vessel v ON v.id = c.vessel_id`;

function toConflict(r: ConflictRowDb, blockers: ConflictBlocker[]): Conflict {
  return {
    id: r.id, importId: r.import_id, type: r.type as ConflictType, status: r.status as Conflict["status"],
    occupantType: r.occupant_type as Conflict["occupantType"], title: r.title,
    vesselId: r.vessel_id, vesselLengthFt: r.vessel_length_ft,
    berthId: r.berth_id, berthName: r.live_berth_name ?? r.berth_name, berthLengthFt: r.berth_length_ft, berthLabel: r.berth_label,
    startDate: r.start_date, endDate: r.end_date, notes: r.notes, sheet: r.sheet, cell: r.cell, message: r.message,
    blockers, bookingId: r.booking_id, bookingIds: r.live_booking_ids ?? [], resolutionNote: r.resolution_note,
    createdAt: isoTime(r.created_at), resolvedAt: r.resolved_at ? isoTime(r.resolved_at) : null,
  };
}

/** One query for a whole page: confirmed bookings on the claimed berth (OVERLAP) or of the same vessel (DOUBLE_BERTHED). */
async function blockersFor(q: Queryable, rows: ConflictRowDb[]): Promise<Map<string, ConflictBlocker[]>> {
  const m = new Map<string, ConflictBlocker[]>();
  const ids = rows.filter((r) => r.type === "OVERLAP" || r.type === "VESSEL_DOUBLE_BERTHED").map((r) => r.id);
  if (!ids.length) return m;
  const { rows: hits } = await q.query<{ conflict_id: string; id: string; display_title: string; berth_name: string; start_date: string; end_date: string }>(
    `SELECT c.id AS conflict_id, bv.id, bv.display_title, bv.berth_name, bv.start_date, bv.end_date
     FROM conflict c
     JOIN booking_view bv ON bv.project_id = c.project_id AND bv.status = 'confirmed'
                         AND bv.start_date <= c.end_date AND bv.end_date >= c.start_date
                         AND ((c.type = 'OVERLAP' AND bv.berth_id = c.berth_id AND bv.berth_kind = 'berth')
                           OR (c.type = 'VESSEL_DOUBLE_BERTHED' AND bv.vessel_id = c.vessel_id))
     WHERE c.id = ANY($1::uuid[])
     ORDER BY bv.start_date`, [ids]);
  for (const h of hits) {
    const list = m.get(h.conflict_id) ?? [];
    list.push({ bookingId: h.id, title: h.display_title, berthName: h.berth_name, startDate: h.start_date, endDate: h.end_date });
    m.set(h.conflict_id, list);
  }
  return m;
}

async function load(q: Queryable, pid: string, id: string): Promise<Conflict> {
  const { rows } = await q.query<ConflictRowDb>(`${SELECT} WHERE c.id = $1 AND c.project_id = $2 AND c.status <> 'staged'`, [id, pid]);
  if (!rows[0]) throw notFound("Conflict");
  return toConflict(rows[0], (await blockersFor(q, rows)).get(id) ?? []);
}

export interface ConflictFilter {
  type?: ConflictType; status?: Conflict["status"]; berthId?: string; q?: string; cursor?: string; limit?: number;
}

/** Earliest claim first (the order a planner works through a season). Cursor = an opaque offset. */
export async function listConflicts(pid: string, f: ConflictFilter): Promise<Page<Conflict>> {
  const q = getDb();
  await requireProject(q, pid);
  const limit = f.limit ?? 50;
  const offset = f.cursor ? Number.parseInt(Buffer.from(f.cursor, "base64url").toString(), 10) || 0 : 0;
  const params: unknown[] = [pid, f.status ?? "open"];
  const where = ["c.project_id = $1", "c.status = $2"];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll("?", `$${params.length}`)); };
  if (f.type) add("c.type = ?", f.type);
  if (f.berthId) add("c.berth_id = ?", f.berthId);
  if (f.q?.trim()) add("(c.title ILIKE ? OR c.berth_label ILIKE ?)", `%${f.q.trim()}%`);
  params.push(limit + 1, offset);
  const { rows } = await q.query<ConflictRowDb>(
    `${SELECT} WHERE ${where.join(" AND ")} ORDER BY c.start_date, c.end_date, c.id
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const page = rows.slice(0, limit);
  const blockers = await blockersFor(q, page);
  return {
    items: page.map((r) => toConflict(r, blockers.get(r.id) ?? [])),
    nextCursor: rows.length > limit ? Buffer.from(String(offset + limit)).toString("base64url") : null,
  };
}

export async function conflictSummary(pid: string): Promise<ConflictSummary> {
  const q = getDb();
  await requireProject(q, pid);
  const [status, types, berths] = await Promise.all([
    q.query<{ status: string; n: number }>(
      "SELECT status, count(*)::int AS n FROM conflict WHERE project_id = $1 AND status <> 'staged' GROUP BY status", [pid]),
    q.query<{ type: ConflictType; n: number }>(
      "SELECT type, count(*)::int AS n FROM conflict WHERE project_id = $1 AND status = 'open' GROUP BY type", [pid]),
    q.query<{ berth_id: string | null; berth_name: string | null; n: number }>(
      `SELECT c.berth_id, coalesce(be.name, c.berth_name) AS berth_name, count(*)::int AS n
       FROM conflict c LEFT JOIN berth be ON be.id = c.berth_id
       WHERE c.project_id = $1 AND c.status = 'open'
       GROUP BY c.berth_id, coalesce(be.name, c.berth_name) ORDER BY n DESC, berth_name NULLS LAST`, [pid]),
  ]);
  const by = (s: string) => status.rows.find((r) => r.status === s)?.n ?? 0;
  const byType = Object.fromEntries(CONFLICT_TYPES.map((t) => [t, 0])) as Record<ConflictType, number>;
  for (const r of types.rows) byType[r.type] = r.n;
  return {
    open: by("open"), placed: by("placed"), dismissed: by("dismissed"), byType,
    byBerth: berths.rows.map((r) => ({ berthId: r.berth_id, berthName: r.berth_name, open: r.n })),
  };
}

/**
 * place: the claim becomes a booking through the normal create path (rules, source "import") on the berth the
 * user chose, optionally on other days. A vessel with no length on record can be given one here.
 * dismiss: the claim is dropped, with an optional reason.
 */
export async function resolveConflict(pid: string, id: string, input: ResolveConflictInput): Promise<Conflict> {
  return getDb().tx(async (q) => {
    const p = await requireProject(q, pid, { write: true });
    const { rows } = await q.query<ConflictRowDb>(
      `${SELECT} WHERE c.id = $1 AND c.project_id = $2 AND c.status <> 'staged' FOR UPDATE OF c`, [id, pid]);
    const c = rows[0];
    if (!c) throw notFound("Conflict");
    if (c.status !== "open") throw new ApiErr("CONFLICT", `This conflict is already ${c.status}.`);

    if (input.action === "dismiss") {
      await q.query("UPDATE conflict SET status = 'dismissed', resolution_note = $2, resolved_at = now() WHERE id = $1",
        [id, input.reason?.trim() || null]);
      return load(q, pid, id);
    }

    let vesselId = c.vessel_id;
    if (c.occupant_type === "vessel") {
      if (!vesselId) {  // its vessel was deleted since: register it again
        const ins = await q.query<{ id: string }>(
          `INSERT INTO vessel (project_id, name, length_ft) VALUES ($1, $2, $3)
           ON CONFLICT (project_id, lower(name)) DO UPDATE SET name = vessel.name RETURNING id`,
          [pid, c.vessel_name, input.vesselLengthFt ?? null]);
        vesselId = ins.rows[0].id;
      }
      if (c.vessel_length_ft == null && input.vesselLengthFt != null) {
        await q.query("UPDATE vessel SET length_ft = $2 WHERE id = $1 AND length_ft IS NULL", [vesselId, input.vesselLengthFt]);
      }
    }
    const booking = await insertBooking(q, pid, {
      berthId: input.berthId, occupantType: c.occupant_type as Conflict["occupantType"],
      vesselId: c.occupant_type === "vessel" ? vesselId : null, title: c.occupant_type === "vessel" ? null : c.title,
      startDate: input.startDate ?? c.start_date, endDate: input.endDate ?? c.end_date, notes: c.notes,
    }, { source: "import", asOfDate: asOfDate(p) });
    await q.query("UPDATE conflict SET status = 'placed', booking_id = $2, booking_ids = ARRAY[$2::uuid], resolved_at = now() WHERE id = $1",
      [id, booking.id]);
    return load(q, pid, id);
  });
}

/** Dismiss many at once: the given ids, or every open conflict of one type. Already-resolved ones are skipped. */
export async function dismissConflicts(pid: string, input: DismissConflictsInput): Promise<{ dismissed: number }> {
  return getDb().tx(async (q) => {
    await requireProject(q, pid, { write: true });
    const reason = input.reason?.trim() || null;
    const r = input.ids
      ? await q.query(
          `UPDATE conflict SET status = 'dismissed', resolution_note = $3, resolved_at = now()
           WHERE project_id = $1 AND status = 'open' AND id = ANY($2::uuid[])`, [pid, input.ids, reason])
      : await q.query(
          `UPDATE conflict SET status = 'dismissed', resolution_note = $3, resolved_at = now()
           WHERE project_id = $1 AND status = 'open' AND type = $2`, [pid, input.type, reason]);
    return { dismissed: r.rowCount };
  });
}
