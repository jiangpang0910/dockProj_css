import { route } from "@/server/http/route";
import { conflictSummary } from "@/server/services/conflicts";

export const runtime = "nodejs";

export const GET = route<{ pid: string }>(async (_req, { pid }) => conflictSummary(pid));
