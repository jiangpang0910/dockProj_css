import { ResolveConflictInputSchema } from "@shared/contract";
import { readJson, route } from "@/server/http/route";
import { resolveConflict } from "@/server/services/conflicts";

export const runtime = "nodejs";

export const POST = route<{ pid: string; cid: string }>(async (req, { pid, cid }) =>
  resolveConflict(pid, cid, await readJson(req, ResolveConflictInputSchema)));
