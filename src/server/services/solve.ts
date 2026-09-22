/**
 * Auto-resolve (backend.md §6.6). Two steps, and nothing changes until the second:
 *   solve  — gather the selected open conflicts + the fixed world around them, ask CP-SAT for proposals. Read-only.
 *   apply  — the user confirms some proposals (one, a few, or all); each becomes one booking per segment through
 *            the normal rules, all in one transaction. Anything that changed since the solve → 409, nothing written.
 */
import type { ApplyProposalsInput, ApplyProposalsResult, SolveRequest, SolveResult } from "@shared/contract";
import type { SolverInput } from "@shared/solver";
import { getDb } from "../db/pool";
import { ApiErr, badRequest } from "../http/api-error";
import { addDays } from "../domain/dates";
import { runSolver } from "../solve/solver";
import { insertBooking } from "./bookings";
import { asOfDate, requireProject } from "./projects";

export const SOLVE_DEFAULTS: SolveResult["options"] = {
  maxDelayDays: 3, maxEarlyDays: 0, maxMoves: 1, minSegmentDays: 2, timeLimitSec: 10,
  weights: { delay: 2, early: 3, move: 3 },
};
export const MAX_SOLVE = 1000;

interface ClaimRow {
  id: string; status: string; title: string; occupant_type: SolverInput["conflicts"][number]["occupantType"];
  vessel_id: string | null; vessel_length_ft: number | null; berth_id: string | null; berth_name: string | null;
  start_date: string; end_date: string;
}

export async function solveConflicts(pid: string, req: SolveRequest): Promise<SolveResult> {
  const { options, input, notOpen } = await buildSolverInput(pid, req);
  const result: SolveResult = input ? await runSolver(input) : {
    status: "OPTIMAL", options, proposals: [], unplaced: [],
    stats: { selected: 0, considered: 0, placed: 0, unplaced: 0, moves: 0, delayDays: 0, slackFootDays: 0, solveMs: 0 },
  };
  result.unplaced.push(...notOpen);
  result.stats.selected += notOpen.length;
  result.stats.unplaced += notOpen.length;
  return result;
}

/**
 * The selected open conflicts + the fixed world around them, as the solver's input (null: nothing open to solve),
 * and the selected ones that are not open. Read-only. Also used by the live monitor (cpsat/).
 */
export async function buildSolverInput(pid: string, req: SolveRequest):
  Promise<{ options: SolveResult["options"]; input: SolverInput | null; notOpen: SolveResult["unplaced"] }> {
  const q = getDb();
  await requireProject(q, pid);
  const options: SolveResult["options"] = {
    ...SOLVE_DEFAULTS, ...req.options, weights: { ...SOLVE_DEFAULTS.weights, ...req.options?.weights },
  };

  const all = req.conflictIds === "all";
  const { rows } = await q.query<ClaimRow>(
    `SELECT c.id, c.status, c.title, c.occupant_type, c.vessel_id, v.length_ft AS vessel_length_ft,
            c.berth_id, coalesce(be.name, c.berth_name) AS berth_name, c.start_date, c.end_date
     FROM conflict c LEFT JOIN vessel v ON v.id = c.vessel_id LEFT JOIN berth be ON be.id = c.berth_id
     WHERE c.project_id = $1 AND ${all ? "c.status = 'open'" : "c.id = ANY($2::uuid[]) AND c.status <> 'staged'"}
     ORDER BY c.start_date, c.id`, all ? [pid] : [pid, req.conflictIds]);
  if (rows.length > MAX_SOLVE) {
    throw badRequest(`${rows.length} open conflicts is more than one solve handles (${MAX_SOLVE}). Filter to fewer.`);
  }

  const open = rows.filter((r) => r.status === "open");
  const found = new Set(rows.map((r) => r.id));
  const notOpen: SolveResult["unplaced"] = [
    ...rows.filter((r) => r.status !== "open").map((r) => ({
      conflictId: r.id, title: r.title, reason: "NOT_OPEN" as const, detail: `Already ${r.status}.` })),
    ...(all ? [] : req.conflictIds as string[]).filter((id) => !found.has(id)).map((id) => ({
      conflictId: id, title: "", reason: "NOT_OPEN" as const, detail: "Not found in this project." })),
  ];
  if (!open.length) return { options, input: null, notOpen };

  // The fixed world only matters inside the widest window any selected claim could move to.
  const from = addDays(open.reduce((m, r) => (r.start_date < m ? r.start_date : m), open[0].start_date), -options.maxEarlyDays);
  const to = addDays(open.reduce((m, r) => (r.end_date > m ? r.end_date : m), open[0].end_date), options.maxDelayDays);
  const vesselIds = [...new Set(open.map((r) => r.vessel_id).filter((v): v is string => !!v))];
  const [berths, berthBusy, vesselBusy] = await Promise.all([
    q.query<{ id: string; name: string; length_ft: number | null }>(
      "SELECT id, name, length_ft FROM berth WHERE project_id = $1 AND active AND kind = 'berth' ORDER BY sort_order, lower(name)", [pid]),
    q.query<{ berth_id: string; start_date: string; end_date: string }>(
      `SELECT berth_id, start_date, end_date FROM booking_view
       WHERE project_id = $1 AND status = 'confirmed' AND berth_kind = 'berth' AND start_date <= $3 AND end_date >= $2`,
      [pid, from, to]),
    q.query<{ vessel_id: string; start_date: string; end_date: string }>(
      `SELECT vessel_id, start_date, end_date FROM booking_view
       WHERE project_id = $1 AND status = 'confirmed' AND vessel_id = ANY($2::uuid[]) AND start_date <= $4 AND end_date >= $3`,
      [pid, vesselIds, from, to]),
  ]);
  const input: SolverInput = {
    options,
    berths: berths.rows.map((b) => ({ id: b.id, name: b.name, lengthFt: b.length_ft })),
    conflicts: open.map((r) => ({
      id: r.id, title: r.title, occupantType: r.occupant_type, vesselId: r.vessel_id, vesselLengthFt: r.vessel_length_ft,
      berthId: r.berth_id, berthName: r.berth_name, startDate: r.start_date, endDate: r.end_date,
    })),
    berthBusy: berthBusy.rows.map((b) => ({ berthId: b.berth_id, startDate: b.start_date, endDate: b.end_date })),
    vesselBusy: vesselBusy.rows.map((b) => ({ vesselId: b.vessel_id, startDate: b.start_date, endDate: b.end_date })),
  };
  return { options, input, notOpen };
}

/**
 * The user's confirmed proposals (any subset of a solve, possibly edited). Each segment is booked through the
 * same rules as a manual placement. One transaction: a single failure rolls the whole batch back, and the error
 * names the conflict it was for.
 */
export async function applyProposals(pid: string, input: ApplyProposalsInput): Promise<ApplyProposalsResult> {
  const ids = input.proposals.map((p) => p.conflictId);
  if (new Set(ids).size !== ids.length) throw badRequest("Each conflict can appear only once.");
  for (const p of input.proposals) {
    for (let i = 0; i < p.segments.length; i++) {
      const s = p.segments[i];
      if (s.endDate < s.startDate) throw badRequest(`A segment ends (${s.endDate}) before it starts (${s.startDate}).`);
      if (i > 0 && s.startDate !== addDays(p.segments[i - 1].endDate, 1)) {
        throw badRequest("The segments of a stay must follow each other day by day, with no gap or overlap.");
      }
    }
  }

  return getDb().tx(async (q) => {
    const project = await requireProject(q, pid, { write: true });
    const { rows } = await q.query<{ id: string; status: string; title: string; occupant_type: ClaimRow["occupant_type"];
      vessel_id: string | null; notes: string | null }>(
      `SELECT id, status, title, occupant_type, vessel_id, notes FROM conflict
       WHERE project_id = $1 AND id = ANY($2::uuid[]) AND status <> 'staged' FOR UPDATE`, [pid, ids]);
    const byId = new Map(rows.map((r) => [r.id, r]));

    const bookingIds: string[] = [];
    for (const p of input.proposals) {
      const c = byId.get(p.conflictId);
      if (!c) throw new ApiErr("NOT_FOUND", "A conflict in this batch no longer exists. Re-run auto-resolve.");
      if (c.status !== "open") throw new ApiErr("CONFLICT", `${c.title} is already ${c.status}. Re-run auto-resolve.`);
      if (c.occupant_type === "vessel" && !c.vessel_id) {
        throw new ApiErr("UNPROCESSABLE", `${c.title}'s vessel was deleted. Place it by hand to register it again.`);
      }
      const mine: string[] = [];
      for (const s of p.segments) {
        try {
          const b = await insertBooking(q, pid, {
            berthId: s.berthId, occupantType: c.occupant_type, vesselId: c.occupant_type === "vessel" ? c.vessel_id : null,
            title: c.occupant_type === "vessel" ? null : c.title, startDate: s.startDate, endDate: s.endDate, notes: c.notes,
          }, { source: "import", asOfDate: asOfDate(project) });
          mine.push(b.id);
        } catch (e) {
          if (e instanceof ApiErr) {
            throw new ApiErr(e.code, `${c.title}: ${e.message} The schedule changed since the solve. Re-run auto-resolve.`, e.violations);
          }
          throw e;
        }
      }
      await q.query(
        `UPDATE conflict SET status = 'placed', booking_id = $2, booking_ids = $3::uuid[], resolved_at = now(),
           resolution_note = $4 WHERE id = $1`,
        [c.id, mine[0], mine, p.segments.length > 1 ? `Auto-resolved: split across ${p.segments.length} berths` : "Auto-resolved"]);
      bookingIds.push(...mine);
    }
    return { placed: input.proposals.length, bookingIds };
  });
}
