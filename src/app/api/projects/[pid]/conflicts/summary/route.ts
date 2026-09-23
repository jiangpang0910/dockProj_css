import { ConflictSummaryQuerySchema } from "@shared/contract";
import { readQuery, route } from "@/server/http/route";
import { conflictSummary } from "@/server/services/conflicts";

export const runtime = "nodejs";

/** With ?from/&to the counts describe that window; with neither, the whole backlog (what the nav badge shows). */
export const GET = route<{ pid: string }>(async (req, { pid }) => conflictSummary(pid, readQuery(req, ConflictSummaryQuerySchema)));
