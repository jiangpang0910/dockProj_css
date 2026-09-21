import { ValidateRequestSchema } from "@shared/contract";
import { readJson, route } from "@/server/http/route";
import { validate } from "@/server/services/bookings";

export const runtime = "nodejs";

/** Dry run: 200 with the violations as the answer (404 only for unknown ids). Never writes. */
export const POST = route<{ pid: string }>(async (req, { pid }) => validate(pid, await readJson(req, ValidateRequestSchema)));
