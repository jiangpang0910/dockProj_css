import { TourPatchSchema } from "@shared/contract";
import { readJson, route } from "@/server/http/route";
import { deleteTour, patchTour } from "@/server/services/tours";

export const runtime = "nodejs";

type P = { pid: string; id: string };
export const PATCH = route<P>(async (req, { pid, id }) => patchTour(pid, id, await readJson(req, TourPatchSchema)));
export const DELETE = route<P>(async (_req, { pid, id }) => { await deleteTour(pid, id); });
