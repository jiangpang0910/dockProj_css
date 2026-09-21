import { VesselInputSchema, VesselsQuerySchema } from "@shared/contract";
import { readJson, readQuery, route } from "@/server/http/route";
import { createVessel, listVessels } from "@/server/services/vessels";

export const runtime = "nodejs";

type P = { pid: string };
export const GET = route<P>(async (req, { pid }) => listVessels(pid, readQuery(req, VesselsQuerySchema)));
export const POST = route<P>(async (req, { pid }) => createVessel(pid, await readJson(req, VesselInputSchema)), { status: 201 });
