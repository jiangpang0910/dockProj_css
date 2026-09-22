import { route } from "@/server/http/route";
import { berthUsage } from "@/server/services/tours";

export const runtime = "nodejs";

type P = { pid: string };
export const GET = route<P>(async (_req, { pid }) => berthUsage(pid));
