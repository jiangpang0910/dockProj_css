import { BookingPatchSchema } from "@shared/contract";
import { readJson, route } from "@/server/http/route";
import { getBooking, patchBooking } from "@/server/services/bookings";

export const runtime = "nodejs";

type P = { pid: string; id: string };
export const GET = route<P>(async (_req, { pid, id }) => getBooking(pid, id));
export const PATCH = route<P>(async (req, { pid, id }) => patchBooking(pid, id, await readJson(req, BookingPatchSchema)));
