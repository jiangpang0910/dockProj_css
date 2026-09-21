import { SolveRequestSchema } from "@shared/contract";
import { readJson, route } from "@/server/http/route";
import { solveConflicts } from "@/server/services/solve";

export const runtime = "nodejs";
export const maxDuration = 60;  // the solver's own limit is ≤ 30 s

/** Proposals only: nothing is written. */
export const POST = route<{ pid: string }>(async (req, { pid }) => solveConflicts(pid, await readJson(req, SolveRequestSchema)));
