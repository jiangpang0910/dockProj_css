import { z } from "zod";
import { TourInputSchema } from "@shared/contract";
import { readJson, readQuery, route } from "@/server/http/route";
import { createTour, listTours } from "@/server/services/tours";

export const runtime = "nodejs";

type P = { pid: string };
const Query = z.object({ from: z.string().optional(), to: z.string().optional(), q: z.string().optional() });
export const GET = route<P>(async (req, { pid }) => listTours(pid, readQuery(req, Query)));
export const POST = route<P>(async (req, { pid }) => createTour(pid, await readJson(req, TourInputSchema)), { status: 201 });
