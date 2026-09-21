import { CancelSchema } from "@shared/contract";
import { readJson, route } from "@/server/http/route";
import { cancelBooking } from "@/server/services/bookings";

export const runtime = "nodejs";

export const POST = route<{ pid: string; id: string }>(async (req, { pid, id }) =>
  cancelBooking(pid, id, (await readJson(req, CancelSchema)).expectedVersion));
