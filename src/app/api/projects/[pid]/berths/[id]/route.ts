import { BerthPatchSchema } from "@shared/contract";
import { readJson, route } from "@/server/http/route";
import { deleteBerth, patchBerth } from "@/server/services/berths";

export const runtime = "nodejs";

type P = { pid: string; id: string };
export const PATCH = route<P>(async (req, { pid, id }) => patchBerth(pid, id, await readJson(req, BerthPatchSchema)));
export const DELETE = route<P>(async (_req, { pid, id }) => { await deleteBerth(pid, id); });
