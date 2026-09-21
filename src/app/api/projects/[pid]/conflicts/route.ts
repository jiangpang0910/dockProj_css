import { ConflictsQuerySchema } from "@shared/contract";
import { readQuery, route } from "@/server/http/route";
import { listConflicts } from "@/server/services/conflicts";

export const runtime = "nodejs";

export const GET = route<{ pid: string }>(async (req, { pid }) => listConflicts(pid, readQuery(req, ConflictsQuerySchema)));
