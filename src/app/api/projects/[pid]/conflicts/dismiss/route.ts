import { DismissConflictsInputSchema } from "@shared/contract";
import { readJson, route } from "@/server/http/route";
import { dismissConflicts } from "@/server/services/conflicts";

export const runtime = "nodejs";

export const POST = route<{ pid: string }>(async (req, { pid }) => dismissConflicts(pid, await readJson(req, DismissConflictsInputSchema)));
