import { AvailabilityQuerySchema } from "@shared/contract";
import { readQuery, route } from "@/server/http/route";
import { availability } from "@/server/services/availability";

export const runtime = "nodejs";

export const GET = route<{ pid: string }>(async (req, { pid }) => availability(pid, readQuery(req, AvailabilityQuerySchema)));
