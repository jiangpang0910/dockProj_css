/**
 * Spreadsheet import (OP-09, OP-10): upload → parse (Python) → stage (window + rules.ts) → preview;
 * commit copies staged rows in one set-based transaction; issues are triaged one by one.
 */
import {
  HARD_HORIZON_YEARS, type ImportIssue, type ImportRun, type ImportedRow, type ISODate, type Page, type ResolveIssueInput,
} from "@shared/contract";
import type { ParsedWorkbook } from "@shared/pipeline";
import type { Queryable } from "../db/types";
import { getDb } from "../db/pool";
import { ApiErr, badRequest, notFound } from "../http/api-error";
import { addYears, isISODate } from "../domain/dates";
import { parseWorkbook } from "../import/parser";
import { stage, type StagePlan } from "../import/stage";
import { insertBooking } from "./bookings";
import { isoTime, normalizeName, toBerth, toVessel } from "./mappers";
import { asOfDate, requireProject } from "./projects";

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

// ─────────────────────────── read ───────────────────────────

const RUN_SELECT = `
  SELECT r.*,
    (SELECT count(*) FROM import_staged_berth s WHERE s.import_id = r.id)::int AS n_berths,
    (SELECT count(*) FROM import_staged_vessel s WHERE s.import_id = r.id AND s.is_new)::int AS n_vessels,
    (SELECT count(*) FROM import_staged_booking s WHERE s.import_id = r.id)::int AS n_bookings,
    (SELECT count(*) FROM import_issue i WHERE i.import_id = r.id)::int AS n_issues,
    (SELECT count(*) FROM import_issue i WHERE i.import_id = r.id AND i.severity = 'error')::int AS n_error,
    (SELECT count(*) FROM import_issue i WHERE i.import_id = r.id AND i.severity = 'warning')::int AS n_warning,
    (SELECT count(*) FROM import_issue i WHERE i.import_id = r.id AND i.severity = 'info')::int AS n_info,
    (SELECT count(*) FROM conflict c WHERE c.import_id = r.id)::int AS n_conflicts,
    (SELECT coalesce(jsonb_object_agg(t.type, t.n), '{}'::jsonb)
       FROM (SELECT type, count(*)::int AS n FROM conflict c WHERE c.import_id = r.id GROUP BY type) t) AS conflict_types
  FROM import_run r`;

function toRun(r: Record<string, unknown>): ImportRun {
  return {
    id: r.id as string, filename: r.filename as string,
    format: r.format as ImportRun["format"], status: r.status as ImportRun["status"],
    createdAt: isoTime(r.created_at), committedAt: r.committed_at ? isoTime(r.committed_at) : null,
    window: { from: r.plan_from as string, to: r.plan_to as string },
    counts: {
      sheets: r.sheets as number, cells: r.cells as number,
      berths: r.n_berths as number, vessels: r.n_vessels as number, bookings: r.n_bookings as number,
      outsideWindow: r.outside_window as number, issues: r.n_issues as number, conflicts: r.n_conflicts as number,
    },
    issueCounts: { error: r.n_error as number, warning: r.n_warning as number, info: r.n_info as number },
    conflictCounts: (typeof r.conflict_types === "string" ? JSON.parse(r.conflict_types) : r.conflict_types) as ImportRun["conflictCounts"],
  };
}

async function loadRun(q: Queryable, pid: string, id: string): Promise<ImportRun> {
  const { rows } = await q.query(`${RUN_SELECT} WHERE r.id = $1 AND r.project_id = $2`, [id, pid]);
  if (!rows[0]) throw notFound("Import");
  return toRun(rows[0]);
}

export async function listImports(pid: string): Promise<ImportRun[]> {
  const q = getDb();
  await requireProject(q, pid);
  const { rows } = await q.query(`${RUN_SELECT} WHERE r.project_id = $1 ORDER BY r.created_at DESC`, [pid]);
  return rows.map(toRun);
}

export async function getImport(pid: string, id: string): Promise<ImportRun> {
  const q = getDb();
  await requireProject(q, pid);
  return loadRun(q, pid, id);
}

// ─────────────────────────── upload → stage ───────────────────────────

export interface UploadOpts {
  planTo?: ISODate;
  /** seeding only: stage everything, no planning window */
  fullWindow?: boolean;
  noModel?: boolean;
  /** tests / seed can hand in an already-parsed workbook */
  parsed?: ParsedWorkbook;
}

export async function uploadImport(pid: string, filename: string, bytes: Uint8Array, opts: UploadOpts = {}): Promise<ImportRun> {
  const db = getDb();
  const p = await requireProject(db, pid, { write: true });
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw badRequest("Files must be 4 MB or smaller.");

  const today = asOfDate(p);
  if (opts.planTo !== undefined && (!isISODate(opts.planTo) || opts.planTo < today)) {
    throw badRequest(`planTo must be a real date on or after the project's today (${today}).`);
  }

  const parsed = opts.parsed ?? (await parseWorkbook(bytes, { noModel: opts.noModel }));
  if (!parsed.format) {
    const why = parsed.issues.find((i) => i.code === "UNKNOWN_FORMAT")?.message
      ?? "This file is neither our template (Berths / Vessels / Bookings sheets) nor the year-per-sheet workbook.";
    throw new ApiErr("UNPROCESSABLE", why);
  }

  // The window. An explicit planTo plans from the project's today. Otherwise the file decides: everything it holds
  // is brought in, and on commit the project's today follows it (commitImport) — so a reviewer handed a workbook
  // from years ago doesn't have to work out its dates before uploading. A file with no dated rows keeps the old default.
  const window = opts.planTo
    ? { from: today, to: opts.planTo }
    : fileWindow(parsed) ?? { from: today, to: addYears(today, HARD_HORIZON_YEARS) };

  // Load the project once (not per row): berths, vessels, confirmed bookings.
  const [berths, vessels, bookings] = await Promise.all([
    db.query("SELECT * FROM berth WHERE project_id = $1", [pid]),
    db.query("SELECT * FROM vessel WHERE project_id = $1", [pid]),
    db.query<{ id: string; berth_id: string; berth_name: string; vessel_id: string | null; display_title: string; start_date: string; end_date: string }>(
      `SELECT id, berth_id, berth_name, vessel_id, display_title, start_date, end_date
       FROM booking_view WHERE project_id = $1 AND status = 'confirmed'`, [pid]),
  ]);
  const plan = await stage({
    parsed,
    window: opts.fullWindow ? null : window,
    existing: {
      berths: berths.rows.map(toBerth),
      vessels: vessels.rows.map(toVessel),
      bookings: bookings.rows.map((b) => ({ id: b.id, berthId: b.berth_id, berthName: b.berth_name, vesselId: b.vessel_id,
        title: b.display_title, startDate: b.start_date, endDate: b.end_date })),
    },
  });

  const stored = opts.fullWindow ? { from: "1997-01-01", to: "2050-12-31" } : window;
  const id = await db.tx((q) => persistPlan(q, pid, filename, parsed, plan, stored));
  return loadRun(db, pid, id);
}

/** Earliest start → latest end over the rows that parsed. Issue rows don't count: a stray 1999 cell shouldn't set the window. */
function fileWindow(parsed: ParsedWorkbook): { from: ISODate; to: ISODate } | null {
  let from: ISODate | null = null;
  let to: ISODate | null = null;
  for (const r of parsed.rows) {
    if (from === null || r.startDate < from) from = r.startDate;
    if (to === null || r.endDate > to) to = r.endDate;
  }
  return from !== null && to !== null ? { from, to } : null;
}

/** One INSERT per table, rows passed as a JSON array (fast over a pooled connection: no per-row round trips). */
async function persistPlan(
  q: Queryable, pid: string, filename: string, parsed: ParsedWorkbook, plan: StagePlan, window: { from: ISODate; to: ISODate },
): Promise<string> {
  const { rows: [{ id }] } = await q.query<{ id: string }>(
    `INSERT INTO import_run (project_id, filename, format, status, sheets, cells, plan_from, plan_to, outside_window)
     VALUES ($1, $2, $3, 'previewed', $4, $5, $6, $7, $8) RETURNING id`,
    [pid, filename, plan.format, parsed.stats.sheets, parsed.stats.cells, window.from, window.to, plan.outsideWindow]);

  const json = (v: unknown) => JSON.stringify(v);
  if (plan.berths.length) {
    await q.query(
      `INSERT INTO import_staged_berth (id, import_id, name, length_ft, sort_order)
       SELECT x.id, $1, x.name, x.length_ft, x.sort_order
       FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, name text, length_ft numeric, sort_order int)`,
      [id, json(plan.berths.map((b) => ({ id: b.id, name: b.name, length_ft: b.lengthFt, sort_order: b.sortOrder })))]);
  }
  if (plan.vessels.length) {
    await q.query(
      `INSERT INTO import_staged_vessel (id, import_id, name, length_ft, draft_ft, operator, notes, is_new)
       SELECT x.id, $1, x.name, x.length_ft, x.draft_ft, x.operator, x.notes, x.is_new
       FROM jsonb_to_recordset($2::jsonb)
         AS x(id uuid, name text, length_ft numeric, draft_ft numeric, operator text, notes text, is_new boolean)`,
      [id, json(plan.vessels.map((v) => ({ id: v.id, name: v.name, length_ft: v.lengthFt, draft_ft: v.draftFt,
        operator: v.operator, notes: v.notes, is_new: v.isNew })))]);
  }
  if (plan.bookings.length) {
    await q.query(
      `INSERT INTO import_staged_booking (id, import_id, berth_id, staged_berth_id, occupant_type, staged_vessel_id, title, start_date, end_date, notes)
       SELECT x.id, $1, x.berth_id, x.staged_berth_id, x.occupant_type, x.staged_vessel_id, x.title, x.start_date, x.end_date, x.notes
       FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, berth_id uuid, staged_berth_id uuid, occupant_type text,
         staged_vessel_id uuid, title text, start_date date, end_date date, notes text)`,
      [id, json(plan.bookings.map((b) => ({ id: b.id, berth_id: b.berthId, staged_berth_id: b.stagedBerthId,
        occupant_type: b.occupantType, staged_vessel_id: b.stagedVesselId, title: b.title,
        start_date: b.startDate, end_date: b.endDate, notes: b.notes })))]);
  }
  if (plan.issues.length) {
    await q.query(
      `INSERT INTO import_issue (import_id, code, severity, sheet, cell, message, row_berth_label, row_occupant_type,
         row_title, row_start_date, row_end_date, row_classified_by, row_notes)
       SELECT $1, x.code, x.severity, x.sheet, x.cell, x.message, x.berth_label, x.occupant_type,
         x.title, x.start_date, x.end_date, x.classified_by, x.notes
       FROM jsonb_to_recordset($2::jsonb) AS x(code text, severity text, sheet text, cell text, message text,
         berth_label text, occupant_type text, title text, start_date date, end_date date, classified_by text, notes text)`,
      [id, json(plan.issues.map((i) => ({ code: i.code, severity: i.severity, sheet: i.sheet, cell: i.cell, message: i.message,
        berth_label: i.row?.berthLabel ?? null, occupant_type: i.row?.occupantType ?? null, title: i.row?.title ?? null,
        start_date: i.row?.startDate ?? null, end_date: i.row?.endDate ?? null, classified_by: i.row?.classifiedBy ?? null,
        notes: i.row?.notes ?? null })))]);
  }
  if (plan.conflicts.length) {
    await q.query(
      `INSERT INTO conflict (project_id, import_id, type, status, occupant_type, title, berth_label, berth_name, vessel_name,
         start_date, end_date, notes, sheet, cell, message)
       SELECT $1, $2, x.type, 'staged', x.occupant_type, x.title, x.berth_label, x.berth_name, x.vessel_name,
         x.start_date, x.end_date, x.notes, x.sheet, x.cell, x.message
       FROM jsonb_to_recordset($3::jsonb) AS x(type text, occupant_type text, title text, berth_label text, berth_name text,
         vessel_name text, start_date date, end_date date, notes text, sheet text, cell text, message text)`,
      [pid, id, json(plan.conflicts.map((c) => ({ type: c.type, occupant_type: c.occupantType, title: c.title,
        berth_label: c.berthLabel, berth_name: c.berthName, vessel_name: c.vesselName, start_date: c.startDate,
        end_date: c.endDate, notes: c.notes, sheet: c.sheet, cell: c.cell, message: c.message })))]);
  }
  return id;
}

// ─────────────────────────── commit / discard ───────────────────────────

/** Berths, then vessels (existing names kept), then bookings — set-based, one transaction. Constraints re-check every row. */
export async function commitImport(pid: string, id: string): Promise<ImportRun> {
  const db = getDb();
  let todaySet: ISODate | null = null;
  await db.tx(async (q) => {
    const p = await requireProject(q, pid, { write: true });
    const { rows } = await q.query<{ status: string; plan_from: string; plan_to: string }>(
      "SELECT status, plan_from, plan_to FROM import_run WHERE id = $1 AND project_id = $2 FOR UPDATE", [id, pid]);
    if (!rows[0]) throw notFound("Import");
    if (rows[0].status !== "previewed") throw new ApiErr("CONFLICT", `This import is already ${rows[0].status}.`);

    await q.query(
      `INSERT INTO berth (project_id, name, length_ft, sort_order)
       SELECT $2, name, length_ft, sort_order FROM import_staged_berth WHERE import_id = $1
       ON CONFLICT (project_id, lower(name)) DO NOTHING`, [id, pid]);
    await q.query(
      `INSERT INTO vessel (project_id, name, length_ft, draft_ft, operator, notes)
       SELECT $2, name, length_ft, draft_ft, operator, notes FROM import_staged_vessel WHERE import_id = $1
       ON CONFLICT (project_id, lower(name)) DO NOTHING`, [id, pid]);
    await q.query(
      `INSERT INTO booking (project_id, berth_id, occupant_type, vessel_id, title, start_date, end_date, source, notes)
       SELECT $2, be.id, sb.occupant_type, v.id, sb.title, sb.start_date, sb.end_date, 'import', sb.notes
       FROM import_staged_booking sb
       LEFT JOIN import_staged_berth isb ON isb.id = sb.staged_berth_id
       JOIN berth be ON be.project_id = $2
                    AND (be.id = sb.berth_id OR (sb.berth_id IS NULL AND lower(be.name) = lower(isb.name)))
       LEFT JOIN import_staged_vessel isv ON isv.id = sb.staged_vessel_id
       LEFT JOIN vessel v ON v.project_id = $2 AND lower(v.name) = lower(isv.name)
       WHERE sb.import_id = $1`, [id, pid]);
    // staged conflicts go live on the Conflicts tab, now pointing at real berth / vessel rows
    await q.query(
      `UPDATE conflict c SET status = 'open',
         berth_id  = (SELECT be.id FROM berth be WHERE be.project_id = $2 AND lower(be.name) = lower(c.berth_name)),
         vessel_id = (SELECT v.id FROM vessel v WHERE v.project_id = $2 AND lower(v.name) = lower(c.vessel_name))
       WHERE c.import_id = $1 AND c.status = 'staged'`, [id, pid]);
    await q.query("UPDATE import_run SET status = 'committed', committed_at = now() WHERE id = $1", [id]);

    // A project made today, a workbook from years ago: with today outside what was just imported the schedule would
    // open on nothing. So today moves to the start of the window. Inside it, today stays where the user put it.
    const today = asOfDate(p);
    if (today < rows[0].plan_from || today > rows[0].plan_to) {
      await q.query("UPDATE project SET as_of_date = $2 WHERE id = $1", [pid, rows[0].plan_from]);
      todaySet = rows[0].plan_from;
    }
  });
  const run = await loadRun(db, pid, id);
  return todaySet ? { ...run, todaySet } : run;
}

/** Discard a preview: staged rows go, the run and its issues stay as a record. */
export async function discardImport(pid: string, id: string): Promise<void> {
  await getDb().tx(async (q) => {
    await requireProject(q, pid, { write: true });
    const { rows } = await q.query<{ status: string }>(
      "SELECT status FROM import_run WHERE id = $1 AND project_id = $2 FOR UPDATE", [id, pid]);
    if (!rows[0]) throw notFound("Import");
    if (rows[0].status === "discarded") return;
    if (rows[0].status !== "previewed") throw new ApiErr("CONFLICT", "A committed import can't be discarded.");
    await q.query("DELETE FROM conflict WHERE import_id = $1 AND status = 'staged'", [id]);
    await q.query("DELETE FROM import_staged_booking WHERE import_id = $1", [id]);
    await q.query("DELETE FROM import_staged_vessel WHERE import_id = $1", [id]);
    await q.query("DELETE FROM import_staged_berth WHERE import_id = $1", [id]);
    await q.query("UPDATE import_run SET status = 'discarded' WHERE id = $1", [id]);
  });
}

// ─────────────────────────── issues ───────────────────────────

interface IssueRowDb {
  id: string; import_id: string; code: string; severity: string; sheet: string; cell: string | null; message: string;
  row_berth_label: string | null; row_occupant_type: string | null; row_title: string | null;
  row_start_date: string | null; row_end_date: string | null; row_classified_by: string | null;
  resolution: string | null;
}

function toIssue(r: IssueRowDb, lengths: Map<string, number | null>): ImportIssue {
  const row: ImportedRow | null = r.row_occupant_type && r.row_title && r.row_start_date && r.row_end_date ? {
    berthLabel: r.row_berth_label,
    occupantType: r.row_occupant_type as ImportedRow["occupantType"],
    title: r.row_title,
    vesselLengthFt: r.row_occupant_type === "vessel" ? lengths.get(normalizeName(r.row_title).toLowerCase()) ?? null : null,
    startDate: r.row_start_date, endDate: r.row_end_date,
    classifiedBy: (r.row_classified_by ?? "regex") as ImportedRow["classifiedBy"],
  } : null;
  return {
    id: r.id, importId: r.import_id, code: r.code as ImportIssue["code"], severity: r.severity as ImportIssue["severity"],
    sheet: r.sheet, cell: r.cell, message: r.message, row,
    resolved: r.resolution != null, resolution: r.resolution as ImportIssue["resolution"],
  };
}

/** Known lengths for the vessels named in these issues: the project's vessels, then this import's staged ones. */
async function vesselLengths(q: Queryable, pid: string, importId: string, rows: IssueRowDb[]): Promise<Map<string, number | null>> {
  const names = [...new Set(rows.filter((r) => r.row_occupant_type === "vessel" && r.row_title)
    .map((r) => normalizeName(r.row_title!).toLowerCase()))];
  const m = new Map<string, number | null>();
  if (!names.length) return m;
  const staged = await q.query<{ k: string; length_ft: number | null }>(
    "SELECT lower(name) AS k, length_ft FROM import_staged_vessel WHERE import_id = $1 AND lower(name) = ANY($2::text[])", [importId, names]);
  for (const r of staged.rows) if (r.length_ft != null) m.set(r.k, r.length_ft);
  const live = await q.query<{ k: string; length_ft: number | null }>(
    "SELECT lower(name) AS k, length_ft FROM vessel WHERE project_id = $1 AND lower(name) = ANY($2::text[])", [pid, names]);
  for (const r of live.rows) if (r.length_ft != null || !m.has(r.k)) m.set(r.k, r.length_ft);
  return m;
}

export interface IssueFilter {
  severity?: "error" | "warning" | "info"; code?: string; resolved?: boolean; cursor?: string; limit?: number;
}

/** Ordered errors → warnings → info, then by sheet/cell. Cursor = an opaque offset. */
export async function listIssues(pid: string, importId: string, f: IssueFilter): Promise<Page<ImportIssue>> {
  const q = getDb();
  await requireProject(q, pid);
  await loadRun(q, pid, importId);
  const limit = f.limit ?? 50;
  const offset = f.cursor ? Number.parseInt(Buffer.from(f.cursor, "base64url").toString(), 10) || 0 : 0;
  const params: unknown[] = [importId];
  const where = ["import_id = $1"];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (f.severity) add("severity = ?", f.severity);
  if (f.code) add("code = ?", f.code);
  if (f.resolved !== undefined) where.push(f.resolved ? "resolution IS NOT NULL" : "resolution IS NULL");
  params.push(limit + 1, offset);
  const { rows } = await q.query<IssueRowDb>(
    `SELECT * FROM import_issue WHERE ${where.join(" AND ")}
     ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, sheet, row_start_date NULLS LAST, cell, id
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const page = rows.slice(0, limit);
  const lengths = await vesselLengths(q, pid, importId, page);
  return {
    items: page.map((r) => toIssue(r, lengths)),
    nextCursor: rows.length > limit ? Buffer.from(String(offset + limit)).toString("base64url") : null,
  };
}

/**
 * create_booking: the issue's row through the normal create path (rules, source "import"), on the berth the user chose.
 * Only after commit — before it, the staged rows aren't live and a manual booking could collide with them at commit.
 * dismiss: allowed any time.
 */
export async function resolveIssue(pid: string, importId: string, issueId: string, input: ResolveIssueInput): Promise<ImportIssue> {
  const db = getDb();
  return db.tx(async (q) => {
    const p = await requireProject(q, pid, { write: true });
    const run = await loadRun(q, pid, importId);
    const { rows } = await q.query<IssueRowDb>(
      "SELECT * FROM import_issue WHERE id = $1 AND import_id = $2 FOR UPDATE", [issueId, importId]);
    const issue = rows[0];
    if (!issue) throw notFound("Issue");
    if (issue.resolution) throw new ApiErr("CONFLICT", `This issue is already ${issue.resolution}.`);

    if (input.action === "dismiss") {
      await q.query("UPDATE import_issue SET resolution = 'dismissed', resolution_note = $2 WHERE id = $1",
        [issueId, input.reason?.trim() || null]);
    } else {
      if (run.status !== "committed") throw new ApiErr("CONFLICT", "Commit the import first, then create bookings from its issues.");
      if (!issue.row_occupant_type || !issue.row_title || !issue.row_start_date || !issue.row_end_date) {
        throw new ApiErr("UNPROCESSABLE", "This issue has no row to make a booking from.");
      }
      let vesselId: string | null = null;
      if (issue.row_occupant_type === "vessel") {
        const name = normalizeName(issue.row_title);
        const found = await q.query<{ id: string; length_ft: number | null }>(
          "SELECT id, length_ft FROM vessel WHERE project_id = $1 AND lower(name) = lower($2)", [pid, name]);
        if (found.rows[0]) {
          vesselId = found.rows[0].id;
          if (found.rows[0].length_ft == null && input.vesselLengthFt != null) {
            await q.query("UPDATE vessel SET length_ft = $2 WHERE id = $1", [vesselId, input.vesselLengthFt]);
          }
        } else {
          const ins = await q.query<{ id: string }>(
            "INSERT INTO vessel (project_id, name, length_ft) VALUES ($1, $2, $3) RETURNING id", [pid, name, input.vesselLengthFt ?? null]);
          vesselId = ins.rows[0].id;
        }
      }
      await insertBooking(q, pid, {
        berthId: input.berthId,
        occupantType: issue.row_occupant_type as ImportedRow["occupantType"],
        vesselId, title: issue.row_occupant_type === "vessel" ? null : issue.row_title,
        startDate: issue.row_start_date, endDate: issue.row_end_date,
      }, { source: "import", asOfDate: asOfDate(p) });
      await q.query("UPDATE import_issue SET resolution = 'created' WHERE id = $1", [issueId]);
    }
    const { rows: [fresh] } = await q.query<IssueRowDb>("SELECT * FROM import_issue WHERE id = $1", [issueId]);
    return toIssue(fresh, await vesselLengths(q, pid, importId, [fresh]));
  });
}
