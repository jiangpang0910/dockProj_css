import { VesselPatchSchema } from "@shared/contract";
import { readJson, route } from "@/server/http/route";
import { deleteVessel, patchVessel } from "@/server/services/vessels";

export const runtime = "nodejs";

type P = { pid: string; id: string };
export const PATCH = route<P>(async (req, { pid, id }) => patchVessel(pid, id, await readJson(req, VesselPatchSchema)));
export const DELETE = route<P>(async (_req, { pid, id }) => { await deleteVessel(pid, id); });
