import { BerthInputSchema, BerthsQuerySchema } from "@shared/contract";
import { readJson, readQuery, route } from "@/server/http/route";
import { createBerth, listBerths } from "@/server/services/berths";

export const runtime = "nodejs";

type P = { pid: string };
export const GET = route<P>(async (req, { pid }) => listBerths(pid, readQuery(req, BerthsQuerySchema).includeInactive ?? false));
export const POST = route<P>(async (req, { pid }) => createBerth(pid, await readJson(req, BerthInputSchema)), { status: 201 });
