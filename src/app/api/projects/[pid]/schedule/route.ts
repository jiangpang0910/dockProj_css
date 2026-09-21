import { WindowQuerySchema } from "@shared/contract";
import { checkWindow, readQuery, route } from "@/server/http/route";
import { getSchedule } from "@/server/services/bookings";

export const runtime = "nodejs";

type P = { pid: string };
export const GET = route<P>(async (req, { pid }) => {
  const { from, to } = readQuery(req, WindowQuerySchema);
  checkWindow(from, to);
  return getSchedule(pid, from, to);
});
