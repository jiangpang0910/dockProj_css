/**
 * The CP-SAT solver's input and output: the contract between `pipeline/docksolve` (Python) and
 * src/server/services/solve.ts. The output is the API's SolveResult (shared/contract.ts), validated here before use.
 * Change this file and pipeline/docksolve together; pipeline/tests/test_solver.py checks the Python side.
 */
import { z } from "zod";
import type { Id, ISODate, OccupantType, SolveResult } from "./contract";

export interface SolverInput {
  options: SolveResult["options"];
  berths: { id: Id; name: string; lengthFt: number | null }[];           // active, exclusive
  conflicts: {
    id: Id; title: string; occupantType: OccupantType; vesselId: Id | null; vesselLengthFt: number | null;
    berthId: Id | null; berthName: string | null; startDate: ISODate; endDate: ISODate;
  }[];
  berthBusy: { berthId: Id; startDate: ISODate; endDate: ISODate }[];   // fixed: confirmed bookings on those berths
  vesselBusy: { vesselId: Id; startDate: ISODate; endDate: ISODate }[]; // fixed: those vessels, on any berth
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const n = z.number();
const int = z.number().int();

export const SolveResultSchema = z.object({
  status: z.enum(["OPTIMAL", "FEASIBLE", "NO_SOLUTION"]),
  options: z.object({
    maxDelayDays: int, maxEarlyDays: int, maxMoves: int, minSegmentDays: int, timeLimitSec: int,
    weights: z.object({ delay: n, early: n, move: n }),
  }),
  stats: z.object({
    selected: int, considered: int, placed: int, unplaced: int, moves: int, delayDays: int, slackFootDays: n, solveMs: int,
  }),
  proposals: z.array(z.object({
    conflictId: z.string(), title: z.string(), occupantType: z.enum(["vessel", "event", "closure"]),
    vesselLengthFt: n.nullable(),
    requested: z.object({ berthId: z.string().nullable(), berthName: z.string().nullable(), startDate: isoDate, endDate: isoDate }),
    segments: z.array(z.object({
      berthId: z.string(), berthName: z.string(), berthLengthFt: n.nullable(),
      startDate: isoDate, endDate: isoDate, slackFt: n.nullable(),
    })).min(1),
    shiftDays: int,
    cost: z.object({ delayDays: int, earlyDays: int, moves: int, slackFootDays: n, offRequestedDays: int }),
  })),
  unplaced: z.array(z.object({
    conflictId: z.string(), title: z.string(),
    reason: z.enum(["CLOSURE", "LENGTH_UNKNOWN", "NO_BERTH_LONG_ENOUGH", "NO_ROOM", "NOT_OPEN"]), detail: z.string(),
  })),
}) satisfies z.ZodType<SolveResult>;
