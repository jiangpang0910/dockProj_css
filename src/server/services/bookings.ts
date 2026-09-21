/**
 * Bookings (OP-02, OP-04–OP-06) and the schedule read. Every write runs rules.ts first (for the message and the
 * blocking ids), inside one transaction; the database constraints are the backstop (database.md §4).
 */
import type {
  BookingInput, BookingPatch, BookingView, ISODate, ScheduleResponse, ValidateRequest, ValidationResult,
} from "@shared/contract";
import type { Queryable } from "../db/types";
import { getDb } from "../db/pool";
import { ApiErr, notFound, ruleError } from "../http/api-error";
import { toResult, validateBooking, type BookingRef, type BookingStore, type RuleContext } from "../domain/rules";
import { toBerth, toBookingView, toVessel } from "./mappers";
import { asOfDate, requireProject } from "./projects";

/** rules.ts's view of the database, scoped to one project (a berth/vessel from another project is "unknown" → 404). */
export class SqlStore implements BookingStore {
  constructor(private q: Queryable, private pid: string) {}

  async getBerth(id: string) {
    const { rows } = await this.q.query("SELECT * FROM berth WHERE id = $1 AND project_id = $2", [id, this.pid]);
    return rows[0] ? toBerth(rows[0]) : null;
  }
  async getVessel(id: string) {
    const { rows } = await this.q.query("SELECT * FROM vessel WHERE id = $1 AND project_id = $2", [id, this.pid]);
    return rows[0] ? toVessel(rows[0]) : null;
  }
  overlapping(berthId: string, start: ISODate, end: ISODate, excludeId?: string) {
    return this.refs("berth_id", berthId, start, end, excludeId);
  }
  vesselBookings(vesselId: string, start: ISODate, end: ISODate, excludeId?: string) {
    return this.refs("vessel_id", vesselId, start, end, excludeId);
  }
  private async refs(col: "berth_id" | "vessel_id", id: string, start: ISODate, end: ISODate, excludeId?: string): Promise<BookingRef[]> {
    const { rows } = await this.q.query<{ id: string; display_title: string; berth_name: string; start_date: string; end_date: string }>(
      `SELECT id, display_title, berth_name, start_date, end_date FROM booking_view
       WHERE ${col} = $1 AND project_id = $2 AND status = 'confirmed' AND ($5::uuid IS NULL OR id <> $5::uuid)
         AND period && daterange($3::date, $4::date, '[]')
       ORDER BY start_date`, [id, this.pid, start, end, excludeId ?? null]);
    return rows.map((r) => ({ id: r.id, title: r.display_title, berthName: r.berth_name, startDate: r.start_date, endDate: r.end_date }));
  }
}

async function loadView(q: Queryable, pid: string, id: string): Promise<BookingView> {
  const { rows } = await q.query("SELECT * FROM booking_view WHERE id = $1 AND project_id = $2", [id, pid]);
  if (!rows[0]) throw notFound("Booking");
  return toBookingView(rows[0]);
}

/** Clean an input for storage: vessels have no title, events/closures have no vessel. */
function normalize(input: BookingInput): BookingInput {
  const isVessel = input.occupantType === "vessel";
  return {
    ...input,
    vesselId: isVessel ? input.vesselId ?? null : null,
    title: isVessel ? null : input.title?.trim() || null,
    notes: input.notes?.trim() || null,
  };
}

export async function validate(pid: string, req: ValidateRequest): Promise<ValidationResult> {
  const q = getDb();
  const p = await requireProject(q, pid);
  const { excludeBookingId, ...input } = req;
  const ctx: RuleContext = { source: "manual", asOfDate: asOfDate(p), excludeId: excludeBookingId };
  return toResult(await validateBooking(normalize(input), new SqlStore(q, pid), ctx));
}

/** Insert one booking after the rules pass. Shared by the API (manual) and import-issue resolution (import). */
export async function insertBooking(q: Queryable, pid: string, raw: BookingInput, ctx: RuleContext): Promise<BookingView> {
  const input = normalize(raw);
  const store = new SqlStore(q, pid);
  const violations = await validateBooking(input, store, ctx);
  if (violations.some((v) => v.severity === "error")) throw ruleError(violations);
  const berth = (await store.getBerth(input.berthId))!;
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO booking (project_id, berth_id, berth_kind, occupant_type, vessel_id, title, start_date, end_date, source, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [pid, berth.id, berth.kind, input.occupantType, input.vesselId, input.title, input.startDate, input.endDate, ctx.source, input.notes]);
  return loadView(q, pid, rows[0].id);
}

export async function createBooking(pid: string, input: BookingInput): Promise<BookingView> {
  return getDb().tx(async (q) => {
    const p = await requireProject(q, pid, { write: true });
    return insertBooking(q, pid, input, { source: "manual", asOfDate: asOfDate(p) });
  });
}

export async function getBooking(pid: string, id: string): Promise<BookingView> {
  const q = getDb();
  await requireProject(q, pid);
  return loadView(q, pid, id);
}

const stale = () => new ApiErr("STALE_VERSION", "This booking changed since you opened it. Reload to see the latest.");

/** PATCH merges onto the stored row, then validates the *result* (excluding itself). */
export async function patchBooking(pid: string, id: string, patch: BookingPatch): Promise<BookingView> {
  return getDb().tx(async (q) => {
    const p = await requireProject(q, pid, { write: true });
    const cur = await loadView(q, pid, id);
    if (cur.version !== patch.expectedVersion) throw stale();
    if (cur.status === "cancelled") throw new ApiErr("CONFLICT", "Cancelled bookings can't be edited.");

    const { expectedVersion, ...changes } = patch;
    const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) as Partial<BookingInput>;
    const merged = normalize({
      berthId: cur.berthId,
      occupantType: cur.occupantType,
      vesselId: cur.vesselId,
      title: cur.occupantType === "vessel" ? null : cur.title,
      startDate: cur.startDate,
      endDate: cur.endDate,
      notes: cur.notes,
      ...defined,
    });
    const store = new SqlStore(q, pid);
    const violations = await validateBooking(merged, store, { source: "manual", asOfDate: asOfDate(p), excludeId: id });
    if (violations.some((v) => v.severity === "error")) throw ruleError(violations);
    const berth = (await store.getBerth(merged.berthId))!;

    const r = await q.query(
      `UPDATE booking SET berth_id = $3, berth_kind = $4, occupant_type = $5, vessel_id = $6, title = $7,
         start_date = $8, end_date = $9, notes = $10, version = version + 1, updated_at = now()
       WHERE id = $1 AND project_id = $2 AND version = $11`,
      [id, pid, berth.id, berth.kind, merged.occupantType, merged.vesselId, merged.title,
       merged.startDate, merged.endDate, merged.notes, expectedVersion]);
    if (r.rowCount === 0) throw stale();
    return loadView(q, pid, id);
  });
}

/** Soft delete: the berth is free again at once. Cancelling an already-cancelled booking is a no-op. */
export async function cancelBooking(pid: string, id: string, expectedVersion: number): Promise<BookingView> {
  return getDb().tx(async (q) => {
    await requireProject(q, pid, { write: true });
    const cur = await loadView(q, pid, id);
    if (cur.status === "cancelled") return cur;
    if (cur.version !== expectedVersion) throw stale();
    const r = await q.query(
      `UPDATE booking SET status = 'cancelled', version = version + 1, updated_at = now()
       WHERE id = $1 AND project_id = $2 AND version = $3`, [id, pid, expectedVersion]);
    if (r.rowCount === 0) throw stale();
    return loadView(q, pid, id);
  });
}

export interface BookingFilter {
  from: ISODate; to: ISODate;
  berthId?: string; vesselId?: string;
  occupantType?: BookingInput["occupantType"];
  q?: string;
  includeCancelled?: boolean;
}

/** Bookings touching [from, to]. The caller has already checked the window size. */
export async function listBookings(pid: string, f: BookingFilter): Promise<BookingView[]> {
  const db = getDb();
  await requireProject(db, pid);
  const params: unknown[] = [pid, f.from, f.to];
  const where = ["project_id = $1", "start_date <= $3::date", "end_date >= $2::date"];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (!f.includeCancelled) where.push("status = 'confirmed'");
  if (f.berthId) add("berth_id = ?", f.berthId);
  if (f.vesselId) add("vessel_id = ?", f.vesselId);
  if (f.occupantType) add("occupant_type = ?", f.occupantType);
  if (f.q?.trim()) add("display_title ILIKE ?", `%${f.q.trim().replace(/[\\%_]/g, (c) => "\\" + c)}%`);
  const { rows } = await db.query(`SELECT * FROM booking_view WHERE ${where.join(" AND ")} ORDER BY start_date, berth_name, display_title`, params);
  return rows.map(toBookingView);
}

/** One round trip for the grid: every berth (incl. inactive, so history still shows) + confirmed bookings in the window. */
export async function getSchedule(pid: string, from: ISODate, to: ISODate): Promise<ScheduleResponse> {
  const db = getDb();
  await requireProject(db, pid);
  const [berths, bookings] = await Promise.all([
    db.query("SELECT * FROM berth WHERE project_id = $1 ORDER BY sort_order, lower(name)", [pid]),
    db.query(
      `SELECT * FROM booking_view WHERE project_id = $1 AND status = 'confirmed'
         AND period && daterange($2::date, $3::date, '[]') ORDER BY berth_id, start_date`, [pid, from, to]),
  ]);
  return { from, to, berths: berths.rows.map(toBerth), bookings: bookings.rows.map(toBookingView) };
}
