import { BookingInputSchema, BookingsQuerySchema } from "@shared/contract";
import { checkWindow, readJson, readQuery, route } from "@/server/http/route";
import { createBooking, listBookings } from "@/server/services/bookings";

export const runtime = "nodejs";

type P = { pid: string };
export const GET = route<P>(async (req, { pid }) => {
  const f = readQuery(req, BookingsQuerySchema);
  checkWindow(f.from, f.to);
  return listBookings(pid, f);
});
export const POST = route<P>(async (req, { pid }) => createBooking(pid, await readJson(req, BookingInputSchema)), { status: 201 });
